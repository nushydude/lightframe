import { generatedImageAssetToUrl, getThumbnail } from './tauriCommands';

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_CONCURRENCY = 6;

type ThumbnailCacheEntry = {
  token: string;
  url?: string;
  lastAccessedAt: number;
  inFlightPromise?: Promise<string>;
};

type ThumbnailLoadedCallback = (path: string) => void;

type PreloadThumbnailOptions = {
  concurrency?: number;
  onLoaded?: ThumbnailLoadedCallback;
  isActive?: () => boolean;
};

export type ThumbnailRequest = {
  path: string;
  sizeBytes?: number;
  modifiedAt?: string | null;
};

const thumbnailCache = new Map<string, ThumbnailCacheEntry>();
const requestMetadataByPath = new Map<string, ThumbnailRequest>();
const queuedRequests = new Set<string>();
const requestQueue: ThumbnailRequestQueueItem[] = [];
const inFlightResolvers = new Map<
  string,
  { resolve: (dataUrl: string) => void; reject: (reason?: unknown) => void }
>();
const listenersByPath = new Map<string, Map<ThumbnailLoadedCallback, PreloadThumbnailOptions>>();
let latestKeepPaths = new Set<string>();

let accessCounter = 0;
let inFlightCount = 0;
let maxEntries = DEFAULT_MAX_ENTRIES;
let concurrencyLimit = DEFAULT_CONCURRENCY;

type ThumbnailRequestQueueItem = {
  path: string;
  token: string;
};

function touchEntry(entry: ThumbnailCacheEntry): void {
  accessCounter += 1;
  entry.lastAccessedAt = accessCounter;
}

function normalizeLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

function getOrCreateEntry(path: string, token: string): ThumbnailCacheEntry {
  const existing = thumbnailCache.get(path);
  if (existing && existing.token === token) {
    touchEntry(existing);
    return existing;
  }

  const created: ThumbnailCacheEntry = {
    token,
    lastAccessedAt: 0,
  };
  touchEntry(created);
  thumbnailCache.set(path, created);
  return created;
}

function normalizeRequest(request: string | ThumbnailRequest): ThumbnailRequest {
  if (typeof request === 'string') {
    return { path: request };
  }
  return request;
}

function parseModifiedAtSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function metadataToken(request: ThumbnailRequest): string {
  return `${request.sizeBytes ?? ''}|${parseModifiedAtSeconds(request.modifiedAt) ?? ''}`;
}

function requestKey(path: string, token: string): string {
  return `${path}::${token}`;
}

function enqueuePath(path: string, token: string): void {
  const key = requestKey(path, token);
  if (queuedRequests.has(key)) return;
  queuedRequests.add(key);
  requestQueue.push({ path, token });
}

function addListener(path: string, options: PreloadThumbnailOptions): void {
  if (!options.onLoaded) return;

  let listeners = listenersByPath.get(path);
  if (!listeners) {
    listeners = new Map<ThumbnailLoadedCallback, PreloadThumbnailOptions>();
    listenersByPath.set(path, listeners);
  }

  listeners.set(options.onLoaded, options);
}

function clearListeners(path: string): void {
  listenersByPath.delete(path);
}

function notifyLoaded(path: string): void {
  const listeners = listenersByPath.get(path);
  if (!listeners) return;

  for (const options of listeners.values()) {
    if (options.isActive && !options.isActive()) {
      continue;
    }

    try {
      options.onLoaded?.(path);
    } catch (error) {
      console.error('Thumbnail onLoaded callback failed:', error);
    }
  }

  listenersByPath.delete(path);
}

function resolveSuccess(path: string, token: string, url: string): void {
  const entry = thumbnailCache.get(path);
  let isCurrentToken = false;
  if (entry && entry.token === token) {
    isCurrentToken = true;
    entry.url = url;
    touchEntry(entry);
    entry.inFlightPromise = undefined;
  }

  const resolverKey = requestKey(path, token);
  const resolver = inFlightResolvers.get(resolverKey);
  inFlightResolvers.delete(resolverKey);
  resolver?.resolve(url);
  if (isCurrentToken) {
    notifyLoaded(path);
  }
  enforceCacheLimit();
}

function resolveError(path: string, token: string, error: unknown): void {
  const entry = thumbnailCache.get(path);
  if (entry?.token === token) {
    thumbnailCache.delete(path);
    requestMetadataByPath.delete(path);
  }

  const resolverKey = requestKey(path, token);
  const resolver = inFlightResolvers.get(resolverKey);
  inFlightResolvers.delete(resolverKey);
  resolver?.reject(error);
  if (entry?.token === token) {
    clearListeners(path);
  }
  enforceCacheLimit();
}

function clearStaleListeners(keepPaths: Set<string>): void {
  for (const path of listenersByPath.keys()) {
    if (!keepPaths.has(path)) {
      listenersByPath.delete(path);
    }
  }
}

function enforceCacheLimit(): void {
  if (thumbnailCache.size <= maxEntries) {
    return;
  }

  const evictable = Array.from(thumbnailCache.entries())
    .filter(([path, entry]) => !latestKeepPaths.has(path) && !entry.inFlightPromise)
    .sort((a, b) => {
      if (a[1].lastAccessedAt !== b[1].lastAccessedAt) {
        return a[1].lastAccessedAt - b[1].lastAccessedAt;
      }
      return a[0].localeCompare(b[0]);
    });

  for (const [path] of evictable) {
    if (thumbnailCache.size <= maxEntries) {
      break;
    }
    thumbnailCache.delete(path);
    for (const key of Array.from(queuedRequests)) {
      if (key.startsWith(`${path}::`)) {
        queuedRequests.delete(key);
      }
    }
    listenersByPath.delete(path);
    requestMetadataByPath.delete(path);
  }
}

function pumpQueue(): void {
  while (inFlightCount < concurrencyLimit && requestQueue.length > 0) {
    const queued = requestQueue.shift();
    if (!queued) {
      return;
    }
    const { path, token } = queued;
    const queuedKey = requestKey(path, token);

    queuedRequests.delete(queuedKey);

    const entry = thumbnailCache.get(path);
    if (!entry?.inFlightPromise || entry.token !== token) {
      continue;
    }

    if (entry.url) {
      resolveSuccess(path, token, entry.url);
      continue;
    }

    inFlightCount += 1;
    const metadata = requestMetadataByPath.get(path);
    if (!metadata || metadataToken(metadata) !== token) {
      inFlightCount -= 1;
      continue;
    }
    getThumbnail(path, metadata?.sizeBytes, metadata?.modifiedAt ?? undefined)
      .then((asset) => {
        resolveSuccess(path, token, generatedImageAssetToUrl(asset));
      })
      .catch((error) => {
        resolveError(path, token, error);
      })
      .finally(() => {
        inFlightCount -= 1;
        pumpQueue();
      });
  }
}

export function getCachedThumbnail(request: string | ThumbnailRequest): string | undefined {
  const normalized = normalizeRequest(request);
  const { path } = normalized;
  const existingMetadata = requestMetadataByPath.get(path);
  if (existingMetadata && metadataToken(existingMetadata) !== metadataToken(normalized)) {
    thumbnailCache.delete(path);
    requestMetadataByPath.set(path, normalized);
  }

  const entry = thumbnailCache.get(path);
  if (!entry?.url || entry.token !== metadataToken(normalized)) {
    return undefined;
  }

  touchEntry(entry);
  return entry.url;
}

// Direct loader is part of the cache test seam.
// fallow-ignore-next-line unused-export
export function loadThumbnail(request: string | ThumbnailRequest): Promise<string> {
  const normalized = normalizeRequest(request);
  const { path, sizeBytes, modifiedAt } = normalized;
  const token = metadataToken(normalized);
  const existingMetadata = requestMetadataByPath.get(path);
  if (existingMetadata && metadataToken(existingMetadata) !== token) {
    thumbnailCache.delete(path);
  }
  const cached = getCachedThumbnail(normalized);
  if (cached) {
    return Promise.resolve(cached);
  }

  const entry = getOrCreateEntry(path, token);

  if (entry.inFlightPromise) {
    return entry.inFlightPromise;
  }

  entry.inFlightPromise = new Promise<string>((resolve, reject) => {
    inFlightResolvers.set(requestKey(path, token), { resolve, reject });
  });

  requestMetadataByPath.set(path, { path, sizeBytes, modifiedAt });
  enqueuePath(path, token);
  pumpQueue();
  return entry.inFlightPromise;
}

export function invalidateThumbnail(path: string): void {
  thumbnailCache.delete(path);
  requestMetadataByPath.delete(path);
  listenersByPath.delete(path);
}

export function preloadThumbnails(
  requests: Array<string | ThumbnailRequest>,
  options: PreloadThumbnailOptions = {}
): void {
  if (typeof options.concurrency === 'number') {
    concurrencyLimit = normalizeConcurrency(options.concurrency);
  }

  const uniqueRequests = new Map<string, ThumbnailRequest>();
  requests.forEach((request) => {
    const normalized = normalizeRequest(request);
    uniqueRequests.set(normalized.path, normalized);
  });

  uniqueRequests.forEach((request, path) => {
    if (options.onLoaded && !getCachedThumbnail(request)) {
      addListener(path, options);
    }

    void loadThumbnail(request).catch(() => {
      // Ignore preload failures and let future attempts retry.
    });
  });
}

export function evictThumbnailsExcept(keepPaths: Set<string>, maxEntriesOverride?: number): void {
  if (typeof maxEntriesOverride === 'number') {
    maxEntries = normalizeLimit(maxEntriesOverride, DEFAULT_MAX_ENTRIES);
  }

  latestKeepPaths = new Set(keepPaths);
  clearStaleListeners(latestKeepPaths);
  enforceCacheLimit();
}

// Reset hook is intentionally test-only.
// fallow-ignore-next-line unused-export
export function clearThumbnailCacheForTests(): void {
  thumbnailCache.clear();
  queuedRequests.clear();
  requestQueue.length = 0;
  inFlightResolvers.clear();
  listenersByPath.clear();
  requestMetadataByPath.clear();
  latestKeepPaths = new Set();
  accessCounter = 0;
  inFlightCount = 0;
  maxEntries = DEFAULT_MAX_ENTRIES;
  concurrencyLimit = DEFAULT_CONCURRENCY;
}

import { generatedImageAssetToUrl, getThumbnail } from './tauriCommands';
import { imageWorkScheduler } from './imageWorkScheduler';
import {
  recordThumbnailCacheHit,
  recordThumbnailCacheMiss,
  setThumbnailCacheEntryCountTelemetry,
} from './performanceTelemetry';

const DEFAULT_MAX_ENTRIES = 1000;
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
const listenersByPath = new Map<string, Map<ThumbnailLoadedCallback, PreloadThumbnailOptions>>();
let latestKeepPaths = new Set<string>();

let accessCounter = 0;
let maxEntries = DEFAULT_MAX_ENTRIES;

function syncThumbnailTelemetry(): void {
  setThumbnailCacheEntryCountTelemetry(thumbnailCache.size);
}

function touchEntry(entry: ThumbnailCacheEntry): void {
  accessCounter += 1;
  entry.lastAccessedAt = accessCounter;
}

function normalizeLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
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
  return `thumbnail:${path}::${token}`;
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
    listenersByPath.delete(path);
    requestMetadataByPath.delete(path);
  }

  syncThumbnailTelemetry();
}

function resolveSuccess(path: string, token: string, url: string): string {
  const entry = thumbnailCache.get(path);
  let isCurrentToken = false;
  if (entry && entry.token === token) {
    isCurrentToken = true;
    entry.url = url;
    touchEntry(entry);
    entry.inFlightPromise = undefined;
  }

  if (isCurrentToken) {
    notifyLoaded(path);
  }

  enforceCacheLimit();
  syncThumbnailTelemetry();
  return url;
}

function resolveError(path: string, token: string, error: unknown): never {
  const entry = thumbnailCache.get(path);
  if (entry?.token === token) {
    thumbnailCache.delete(path);
    requestMetadataByPath.delete(path);
    clearListeners(path);
  }

  enforceCacheLimit();
  syncThumbnailTelemetry();
  throw error;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function loadThumbnailWithPriority(
  request: string | ThumbnailRequest,
  priority: 'visible-thumbnail' | 'background-preload' = 'visible-thumbnail'
): Promise<string> {
  const normalized = normalizeRequest(request);
  const { path, sizeBytes, modifiedAt } = normalized;
  const token = metadataToken(normalized);
  const existingMetadata = requestMetadataByPath.get(path);
  if (existingMetadata && metadataToken(existingMetadata) !== token) {
    imageWorkScheduler.cancelQueued((job) => job.key.startsWith(`thumbnail:${path}::`));
    thumbnailCache.delete(path);
  }

  const cached = getCachedThumbnail(normalized);
  if (cached) {
    return Promise.resolve(cached);
  }

  recordThumbnailCacheMiss();
  const entry = getOrCreateEntry(path, token);
  if (entry.inFlightPromise) {
    return entry.inFlightPromise;
  }

  requestMetadataByPath.set(path, { path, sizeBytes, modifiedAt });
  entry.inFlightPromise = imageWorkScheduler
    .schedule({
      key: requestKey(path, token),
      sourcePath: path,
      priority,
      generationToken: token,
      run: async ({ signal }) => {
        if (signal.aborted) {
          throw createAbortError('Thumbnail work aborted before execution.');
        }

        const latestRequest = requestMetadataByPath.get(path);
        if (!latestRequest || metadataToken(latestRequest) !== token) {
          throw createAbortError('Thumbnail request became stale before execution.');
        }

        const asset = await getThumbnail(path, sizeBytes, modifiedAt ?? undefined);
        if (signal.aborted) {
          throw createAbortError('Thumbnail work aborted after execution.');
        }

        return generatedImageAssetToUrl(asset);
      },
    })
    .promise
    .then((url) => resolveSuccess(path, token, url))
    .catch((error) => resolveError(path, token, error));

  syncThumbnailTelemetry();
  return entry.inFlightPromise;
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
  recordThumbnailCacheHit();
  syncThumbnailTelemetry();
  return entry.url;
}

// Direct loader is part of the cache test seam.
// fallow-ignore-next-line unused-export
export function loadThumbnail(request: string | ThumbnailRequest): Promise<string> {
  return loadThumbnailWithPriority(request, 'visible-thumbnail');
}

export function invalidateThumbnail(path: string): void {
  imageWorkScheduler.cancelQueued(
    (job) => job.sourcePath === path && job.key.startsWith(`thumbnail:${path}::`)
  );
  thumbnailCache.delete(path);
  requestMetadataByPath.delete(path);
  listenersByPath.delete(path);
  syncThumbnailTelemetry();
}

export function preloadThumbnails(
  requests: Array<string | ThumbnailRequest>,
  options: PreloadThumbnailOptions = {}
): void {
  const uniqueRequests = new Map<string, ThumbnailRequest>();
  requests.forEach((request) => {
    const normalized = normalizeRequest(request);
    uniqueRequests.set(normalized.path, normalized);
  });

  uniqueRequests.forEach((request, path) => {
    if (options.onLoaded && !getCachedThumbnail(request)) {
      addListener(path, options);
    }

    void loadThumbnailWithPriority(request, 'visible-thumbnail').catch(() => {
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
  imageWorkScheduler.cancelQueued(
    (job) =>
      job.priority === 'visible-thumbnail' &&
      job.key.startsWith('thumbnail:') &&
      !latestKeepPaths.has(job.sourcePath)
  );
  enforceCacheLimit();
}

// Reset hook is intentionally test-only.
// fallow-ignore-next-line unused-export
export function clearThumbnailCacheForTests(): void {
  imageWorkScheduler.resetForTests();
  thumbnailCache.clear();
  listenersByPath.clear();
  requestMetadataByPath.clear();
  latestKeepPaths = new Set();
  accessCounter = 0;
  maxEntries = DEFAULT_MAX_ENTRIES;
  syncThumbnailTelemetry();
}

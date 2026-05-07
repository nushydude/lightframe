import { getThumbnail } from './tauriCommands';

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_CONCURRENCY = 6;

type ThumbnailCacheEntry = {
  dataUrl?: string;
  lastAccessedAt: number;
  inFlightPromise?: Promise<string>;
};

type ThumbnailLoadedCallback = (path: string) => void;

type PreloadThumbnailOptions = {
  concurrency?: number;
  onLoaded?: ThumbnailLoadedCallback;
  isActive?: () => boolean;
};

const thumbnailCache = new Map<string, ThumbnailCacheEntry>();
const queuedPaths = new Set<string>();
const requestQueue: string[] = [];
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

function getOrCreateEntry(path: string): ThumbnailCacheEntry {
  const existing = thumbnailCache.get(path);
  if (existing) {
    touchEntry(existing);
    return existing;
  }

  const created: ThumbnailCacheEntry = {
    lastAccessedAt: 0,
  };
  touchEntry(created);
  thumbnailCache.set(path, created);
  return created;
}

function enqueuePath(path: string): void {
  if (queuedPaths.has(path)) return;
  queuedPaths.add(path);
  requestQueue.push(path);
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

function resolveSuccess(path: string, dataUrl: string): void {
  const entry = thumbnailCache.get(path);
  if (entry) {
    entry.dataUrl = dataUrl;
    touchEntry(entry);
    entry.inFlightPromise = undefined;
  }

  const resolver = inFlightResolvers.get(path);
  inFlightResolvers.delete(path);
  resolver?.resolve(dataUrl);
  notifyLoaded(path);
  enforceCacheLimit();
}

function resolveError(path: string, error: unknown): void {
  thumbnailCache.delete(path);
  queuedPaths.delete(path);

  const resolver = inFlightResolvers.get(path);
  inFlightResolvers.delete(path);
  resolver?.reject(error);
  clearListeners(path);
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
    queuedPaths.delete(path);
    inFlightResolvers.delete(path);
    listenersByPath.delete(path);
  }
}

function pumpQueue(): void {
  while (inFlightCount < concurrencyLimit && requestQueue.length > 0) {
    const path = requestQueue.shift();
    if (!path) {
      return;
    }

    queuedPaths.delete(path);

    const entry = thumbnailCache.get(path);
    if (!entry?.inFlightPromise) {
      continue;
    }

    if (entry.dataUrl) {
      resolveSuccess(path, entry.dataUrl);
      continue;
    }

    inFlightCount += 1;
    getThumbnail(path)
      .then((dataUrl) => {
        resolveSuccess(path, dataUrl);
      })
      .catch((error) => {
        resolveError(path, error);
      })
      .finally(() => {
        inFlightCount -= 1;
        pumpQueue();
      });
  }
}

export function getCachedThumbnail(path: string): string | undefined {
  const entry = thumbnailCache.get(path);
  if (!entry?.dataUrl) {
    return undefined;
  }

  touchEntry(entry);
  return entry.dataUrl;
}

export function loadThumbnail(path: string): Promise<string> {
  const cached = getCachedThumbnail(path);
  if (cached) {
    return Promise.resolve(cached);
  }

  const entry = getOrCreateEntry(path);
  if (entry.inFlightPromise) {
    return entry.inFlightPromise;
  }

  entry.inFlightPromise = new Promise<string>((resolve, reject) => {
    inFlightResolvers.set(path, { resolve, reject });
  });

  enqueuePath(path);
  pumpQueue();
  return entry.inFlightPromise;
}

export function preloadThumbnails(paths: string[], options: PreloadThumbnailOptions = {}): void {
  if (typeof options.concurrency === 'number') {
    concurrencyLimit = normalizeConcurrency(options.concurrency);
  }

  const uniquePaths = new Set(paths);
  uniquePaths.forEach((path) => {
    if (options.onLoaded && !getCachedThumbnail(path)) {
      addListener(path, options);
    }

    void loadThumbnail(path).catch(() => {
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

export function clearThumbnailCacheForTests(): void {
  thumbnailCache.clear();
  queuedPaths.clear();
  requestQueue.length = 0;
  inFlightResolvers.clear();
  listenersByPath.clear();
  latestKeepPaths = new Set();
  accessCounter = 0;
  inFlightCount = 0;
  maxEntries = DEFAULT_MAX_ENTRIES;
  concurrencyLimit = DEFAULT_CONCURRENCY;
}

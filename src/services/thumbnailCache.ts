import { generatedImageAssetToUrl, getThumbnail, type GeneratedImageAsset } from './tauriCommands';
import { imageWorkScheduler } from './imageWorkScheduler';
import {
  recordThumbnailCacheHit,
  recordThumbnailCacheMiss,
  setThumbnailCacheBudgetBytesTelemetry,
  setThumbnailCacheEstimatedBytesTelemetry,
  setThumbnailCacheEntryCountTelemetry,
} from './performanceTelemetry';
import { estimateThumbnailAssetBytes } from './cacheMemory';
import { getPerformanceModeProfile } from './performanceMode';
import {
  releaseRetainedDecodedImage,
  retainDecodedImage,
  type RetainedImageHandle,
} from './retainedImage';

const DEFAULT_FALLBACK_THUMBNAIL_SIZE = 160;
type ThumbnailCacheEntry = {
  token: string;
  url?: string;
  estimatedBytes: number;
  lastAccessedAt: number;
  retainedImage?: RetainedImageHandle;
  inFlightPromise?: Promise<string>;
};

type ThumbnailLoadedCallback = (path: string) => void;

type PreloadThumbnailOptions = {
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
let thumbnailCacheBudgetBytes = getPerformanceModeProfile('balanced').thumbnailCacheBudgetBytes;
let thumbnailCacheEstimatedBytes = 0;

function syncThumbnailTelemetry(): void {
  setThumbnailCacheEntryCountTelemetry(thumbnailCache.size);
  setThumbnailCacheEstimatedBytesTelemetry(thumbnailCacheEstimatedBytes);
  setThumbnailCacheBudgetBytesTelemetry(thumbnailCacheBudgetBytes);
}

function touchEntry(entry: ThumbnailCacheEntry): void {
  accessCounter += 1;
  entry.lastAccessedAt = accessCounter;
}

function normalizeLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function releaseThumbnailCacheEntry(entry: ThumbnailCacheEntry): void {
  releaseRetainedDecodedImage(entry.retainedImage);
}

function deleteThumbnailCacheEntry(path: string): void {
  const entry = thumbnailCache.get(path);
  if (!entry) {
    return;
  }

  thumbnailCache.delete(path);
  thumbnailCacheEstimatedBytes -= entry.estimatedBytes;
  releaseThumbnailCacheEntry(entry);
}

function setThumbnailCacheEntry(path: string, entry: ThumbnailCacheEntry): void {
  deleteThumbnailCacheEntry(path);
  thumbnailCache.set(path, entry);
  thumbnailCacheEstimatedBytes += entry.estimatedBytes;
}

function updateThumbnailEntryAsset(
  entry: ThumbnailCacheEntry,
  url: string,
  width?: number | null,
  height?: number | null
): void {
  releaseRetainedDecodedImage(entry.retainedImage);
  thumbnailCacheEstimatedBytes -= entry.estimatedBytes;
  entry.url = url;
  entry.estimatedBytes = estimateThumbnailAssetBytes({
    url,
    width,
    height,
    fallbackSize: DEFAULT_FALLBACK_THUMBNAIL_SIZE,
  });
  entry.retainedImage = retainDecodedImage(url);
  thumbnailCacheEstimatedBytes += entry.estimatedBytes;
}

function getOrCreateEntry(path: string, token: string): ThumbnailCacheEntry {
  const existing = thumbnailCache.get(path);
  if (existing && existing.token === token) {
    touchEntry(existing);
    return existing;
  }

  const created: ThumbnailCacheEntry = {
    token,
    estimatedBytes: 0,
    lastAccessedAt: 0,
  };
  touchEntry(created);
  setThumbnailCacheEntry(path, created);
  return created;
}

function normalizeRequest(request: string | ThumbnailRequest): ThumbnailRequest {
  if (typeof request === 'string') {
    return { path: request };
  }
  return request;
}

function normalizeModifiedAt(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function metadataToken(request: ThumbnailRequest): string {
  return `${request.sizeBytes ?? ''}|${normalizeModifiedAt(request.modifiedAt) ?? ''}`;
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
  if (thumbnailCacheEstimatedBytes <= thumbnailCacheBudgetBytes) {
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
    if (thumbnailCacheEstimatedBytes <= thumbnailCacheBudgetBytes) {
      break;
    }

    deleteThumbnailCacheEntry(path);
    listenersByPath.delete(path);
    requestMetadataByPath.delete(path);
  }

  syncThumbnailTelemetry();
}

function resolveSuccess(path: string, token: string, asset: GeneratedImageAsset): string {
  const url = generatedImageAssetToUrl(asset);
  const entry = thumbnailCache.get(path);
  let isCurrentToken = false;
  if (entry && entry.token === token) {
    isCurrentToken = true;
    updateThumbnailEntryAsset(entry, url, asset.width, asset.height);
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
    deleteThumbnailCacheEntry(path);
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
    deleteThumbnailCacheEntry(path);
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

        return asset;
      },
    })
    .promise.then((asset) => resolveSuccess(path, token, asset))
    .catch((error) => resolveError(path, token, error));

  syncThumbnailTelemetry();
  return entry.inFlightPromise;
}

export function getCachedThumbnail(request: string | ThumbnailRequest): string | undefined {
  const normalized = normalizeRequest(request);
  const { path } = normalized;
  const existingMetadata = requestMetadataByPath.get(path);
  if (existingMetadata && metadataToken(existingMetadata) !== metadataToken(normalized)) {
    deleteThumbnailCacheEntry(path);
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
// fallow-ignore-next-line unused-export -- direct cache loader test seam
export function loadThumbnail(request: string | ThumbnailRequest): Promise<string> {
  return loadThumbnailWithPriority(request, 'visible-thumbnail');
}

export function invalidateThumbnail(path: string): void {
  imageWorkScheduler.cancelQueued(
    (job) => job.sourcePath === path && job.key.startsWith(`thumbnail:${path}::`)
  );
  deleteThumbnailCacheEntry(path);
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

export function evictThumbnailsExcept(
  keepPaths: Set<string>,
  cacheBudgetBytesOverride?: number
): void {
  if (typeof cacheBudgetBytesOverride === 'number') {
    thumbnailCacheBudgetBytes = normalizeLimit(cacheBudgetBytesOverride, thumbnailCacheBudgetBytes);
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

export function configureThumbnailCache(options: { cacheBudgetBytes?: number }): void {
  thumbnailCacheBudgetBytes = normalizeLimit(
    options.cacheBudgetBytes ?? thumbnailCacheBudgetBytes,
    thumbnailCacheBudgetBytes
  );
  enforceCacheLimit();
  syncThumbnailTelemetry();
}

// Reset hook is intentionally test-only.
// fallow-ignore-next-line unused-export -- test-only cache reset seam
export function clearThumbnailCacheForTests(): void {
  imageWorkScheduler.resetForTests();
  for (const entry of thumbnailCache.values()) {
    releaseThumbnailCacheEntry(entry);
  }
  thumbnailCache.clear();
  thumbnailCacheEstimatedBytes = 0;
  listenersByPath.clear();
  requestMetadataByPath.clear();
  latestKeepPaths = new Set();
  accessCounter = 0;
  thumbnailCacheBudgetBytes = getPerformanceModeProfile('balanced').thumbnailCacheBudgetBytes;
  syncThumbnailTelemetry();
}

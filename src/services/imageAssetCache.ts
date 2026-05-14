import { convertFileSrc, generatedImageAssetToUrl, getPreviewImage } from './tauriCommands';
import {
  IMAGE_WORK_PRIORITY,
  imageWorkScheduler,
  type ImageWorkPriority,
} from './imageWorkScheduler';
import {
  measurePerformanceSpan,
  recordFullAssetCacheHit,
  recordFullAssetCacheMiss,
  recordPreviewAssetCacheHit,
  recordPreviewAssetCacheMiss,
  setFullAssetCacheEntryCountTelemetry,
  setPreviewAssetCacheEntryCountTelemetry,
} from './performanceTelemetry';

type ImageAssetEntry = {
  url: string;
  version: number;
  lastUsedAt: number;
};

type PreviewAssetEntry = {
  url: string;
  version: number;
  maxDimension: number;
  lastUsedAt: number;
};

type CacheStoreGuard = () => boolean;

type CacheReadOptions = {
  canStore?: CacheStoreGuard;
  signal?: AbortSignal;
};

type ScheduledCacheReadOptions = CacheReadOptions & {
  priority?: ImageWorkPriority;
};

type CacheTrimOptions = {
  pruneMissing?: boolean;
};

const fullImageAssetCache = new Map<string, ImageAssetEntry>();
const previewImageAssetCache = new Map<string, PreviewAssetEntry>();
const pendingInvalidations = new Map<string, number>();
const latestMutationVersions = new Map<string, number>();
const DEFAULT_PREVIEW_MAX_DIMENSION = 2048;
const MAX_PREVIEW_CACHE_ENTRIES = 12;

function syncImageAssetTelemetry(): void {
  setFullAssetCacheEntryCountTelemetry(fullImageAssetCache.size);
  setPreviewAssetCacheEntryCountTelemetry(previewImageAssetCache.size);
}

function applyVersionToUrl(url: string, version: number): string {
  if (version <= 0) {
    return removeVersionFromUrl(url);
  }

  return updateUrlSearchParams(url, (params) => params.set('v', String(version)));
}

function removeVersionFromUrl(url: string): string {
  return updateUrlSearchParams(url, (params) => params.delete('v'));
}

function updateUrlSearchParams(url: string, update: (params: URLSearchParams) => void): string {
  try {
    const parsed = new URL(url);
    update(parsed.searchParams);
    return parsed.toString();
  } catch {
    const hashIndex = url.indexOf('#');
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const [pathPart, queryPart = ''] = base.split('?', 2);
    const params = new URLSearchParams(queryPart);
    update(params);
    const query = params.toString();
    return `${pathPart}${query ? `?${query}` : ''}${hash}`;
  }
}

function createCacheEntry(path: string, version: number): ImageAssetEntry {
  const baseUrl = convertFileSrc(path);
  return {
    url: applyVersionToUrl(baseUrl, version),
    version,
    lastUsedAt: Date.now(),
  };
}

function currentVersion(path: string): number {
  return Math.max(pendingInvalidations.get(path) ?? 0, latestMutationVersions.get(path) ?? 0);
}

function trimCacheEntries<T extends { lastUsedAt: number }>(
  cache: Map<string, T>,
  keepPaths: Set<string>,
  maxEntries: number
): void {
  if (maxEntries < 0 || cache.size <= maxEntries) return;

  const evictable = Array.from(cache.entries())
    .filter(([path]) => !keepPaths.has(path))
    .sort((a, b) => {
      if (a[1].lastUsedAt !== b[1].lastUsedAt) {
        return a[1].lastUsedAt - b[1].lastUsedAt;
      }
      return a[0].localeCompare(b[0]);
    });

  for (const [path] of evictable) {
    if (cache.size <= maxEntries) break;
    cache.delete(path);
  }
}

function shouldStore(options?: CacheReadOptions): boolean {
  return options?.canStore?.() ?? true;
}

function maybePruneEntries<T>(cache: Map<string, T>, keepPaths: Set<string>): void {
  for (const path of cache.keys()) {
    if (!keepPaths.has(path)) {
      cache.delete(path);
    }
  }
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function buildFullAssetEntry(path: string): ImageAssetEntry {
  const startVersion = currentVersion(path);
  const entry = createCacheEntry(path, startVersion);
  const resolvedVersion = Math.max(startVersion, currentVersion(path));

  if (resolvedVersion !== entry.version) {
    entry.version = resolvedVersion;
    entry.url = applyVersionToUrl(entry.url, resolvedVersion);
  }

  return entry;
}

function fullAssetWorkKey(path: string, version: number): string {
  return `full::${path}::${version}`;
}

function previewAssetWorkKey(path: string, maxDimension: number, version: number): string {
  return `preview::${path}::${maxDimension}::${version}`;
}

function workScope(priority: ImageWorkPriority): 'interactive' | 'background' {
  return priority === IMAGE_WORK_PRIORITY.currentPreview ||
    priority === IMAGE_WORK_PRIORITY.currentFull
    ? 'interactive'
    : 'background';
}

function scopedFullAssetWorkKey(
  path: string,
  version: number,
  priority: ImageWorkPriority
): string {
  return `${fullAssetWorkKey(path, version)}::${workScope(priority)}`;
}

function scopedPreviewAssetWorkKey(
  path: string,
  maxDimension: number,
  version: number,
  priority: ImageWorkPriority
): string {
  return `${previewAssetWorkKey(path, maxDimension, version)}::${workScope(priority)}`;
}

function storeFullAsset(path: string, entry: ImageAssetEntry, options?: CacheReadOptions): string {
  if (!shouldStore(options)) {
    syncImageAssetTelemetry();
    return entry.url;
  }

  const current = fullImageAssetCache.get(path);
  if (current && current.version >= entry.version) {
    current.lastUsedAt = Date.now();
    recordFullAssetCacheHit();
    syncImageAssetTelemetry();
    return current.url;
  }

  fullImageAssetCache.set(path, entry);
  if (entry.version > 0) {
    latestMutationVersions.set(path, entry.version);
  }

  if (pendingInvalidations.get(path) === entry.version) {
    pendingInvalidations.delete(path);
  }

  syncImageAssetTelemetry();
  return entry.url;
}

function storePreviewAsset(
  path: string,
  entry: PreviewAssetEntry,
  options?: CacheReadOptions
): string {
  if (!shouldStore(options)) {
    syncImageAssetTelemetry();
    return entry.url;
  }

  const current = previewImageAssetCache.get(path);
  if (current && current.version >= entry.version && current.maxDimension === entry.maxDimension) {
    current.lastUsedAt = Date.now();
    recordPreviewAssetCacheHit();
    syncImageAssetTelemetry();
    return current.url;
  }

  previewImageAssetCache.set(path, entry);
  if (entry.version > 0) {
    latestMutationVersions.set(path, entry.version);
  }
  if (pendingInvalidations.get(path) === entry.version) {
    pendingInvalidations.delete(path);
  }

  trimCacheEntries(previewImageAssetCache, new Set([path]), MAX_PREVIEW_CACHE_ENTRIES);
  syncImageAssetTelemetry();
  return entry.url;
}

async function loadFullAssetWithPriority(
  path: string,
  priority: ImageWorkPriority,
  options?: CacheReadOptions
): Promise<string> {
  const version = currentVersion(path);
  const cached = fullImageAssetCache.get(path);
  if (cached && cached.version === version) {
    cached.lastUsedAt = Date.now();
    recordFullAssetCacheHit();
    syncImageAssetTelemetry();
    return cached.url;
  }

  return imageWorkScheduler.schedule({
    key: scopedFullAssetWorkKey(path, version, priority),
    priority,
    sourcePath: path,
    generationToken: version,
    signal: options?.signal,
    run: ({ signal }) => {
      if (signal.aborted) {
        throw createAbortError('Full asset work aborted before execution.');
      }

      recordFullAssetCacheMiss();
      const entry = buildFullAssetEntry(path);

      if (signal.aborted) {
        throw createAbortError('Full asset work aborted after execution.');
      }

      return storeFullAsset(path, entry, options);
    },
  }).promise;
}

async function loadPreviewAssetWithPriority(
  path: string,
  maxDimension: number,
  priority: ImageWorkPriority,
  options?: CacheReadOptions
): Promise<string> {
  const version = currentVersion(path);
  const existing = previewImageAssetCache.get(path);
  if (existing && existing.version === version && existing.maxDimension === maxDimension) {
    existing.lastUsedAt = Date.now();
    recordPreviewAssetCacheHit();
    syncImageAssetTelemetry();
    return existing.url;
  }

  return imageWorkScheduler.schedule({
    key: scopedPreviewAssetWorkKey(path, maxDimension, version, priority),
    priority,
    sourcePath: path,
    generationToken: version,
    signal: options?.signal,
    run: async ({ signal }) => {
      if (signal.aborted) {
        throw createAbortError('Preview work aborted before execution.');
      }

      recordPreviewAssetCacheMiss();
      const initialVersion = currentVersion(path);
      const initialBust = initialVersion > 0 ? initialVersion : undefined;
      let entry: PreviewAssetEntry = {
        url: generatedImageAssetToUrl(
          await measurePerformanceSpan('previewGeneration', () =>
            getPreviewImage(path, maxDimension, initialBust)
          )
        ),
        version: initialVersion,
        maxDimension,
        lastUsedAt: Date.now(),
      };

      const resolvedVersion = Math.max(initialVersion, currentVersion(path));
      if (resolvedVersion !== entry.version) {
        const resolvedBust = resolvedVersion > 0 ? resolvedVersion : undefined;
        entry = {
          url: generatedImageAssetToUrl(
            await measurePerformanceSpan('previewGeneration', () =>
              getPreviewImage(path, maxDimension, resolvedBust)
            )
          ),
          version: resolvedVersion,
          maxDimension,
          lastUsedAt: Date.now(),
        };
      }

      if (signal.aborted) {
        throw createAbortError('Preview work aborted after execution.');
      }

      return storePreviewAsset(path, entry, options);
    },
  }).promise;
}

export function requestFullAsset(path: string, options?: CacheReadOptions): Promise<string> {
  return loadFullAssetWithPriority(path, IMAGE_WORK_PRIORITY.currentFull, options);
}

export async function getPreviewAsset(
  path: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  options?: CacheReadOptions
): Promise<string> {
  return loadPreviewAssetWithPriority(
    path,
    maxDimension,
    IMAGE_WORK_PRIORITY.currentPreview,
    options
  );
}

export async function preloadFullAsset(
  path: string,
  options?: ScheduledCacheReadOptions
): Promise<void> {
  if (!shouldStore(options)) {
    return;
  }

  const url = await loadFullAssetWithPriority(
    path,
    options?.priority ?? IMAGE_WORK_PRIORITY.backgroundPreload,
    options
  );
  if (!shouldStore(options)) {
    return;
  }

  const img = new Image();
  img.src = url;
}

export async function preloadPreviewAsset(
  path: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  options?: ScheduledCacheReadOptions
): Promise<void> {
  if (!shouldStore(options)) {
    return;
  }

  const url = await loadPreviewAssetWithPriority(
    path,
    maxDimension,
    options?.priority ?? IMAGE_WORK_PRIORITY.backgroundPreload,
    options
  );
  if (!shouldStore(options)) {
    return;
  }

  const img = new Image();
  img.src = url;
}

export function invalidateImageAsset(path: string): void {
  const version = Date.now();
  pendingInvalidations.set(path, version);
  latestMutationVersions.set(path, version);

  imageWorkScheduler.cancelQueued((job) => job.sourcePath === path);
  fullImageAssetCache.delete(path);
  previewImageAssetCache.delete(path);
  syncImageAssetTelemetry();
}

export function trimImageAssetCache(
  keepPaths: Set<string>,
  maxEntries: number,
  options?: CacheTrimOptions
): void {
  if (options?.pruneMissing) {
    maybePruneEntries(fullImageAssetCache, keepPaths);
    maybePruneEntries(previewImageAssetCache, keepPaths);
  }

  trimCacheEntries(fullImageAssetCache, keepPaths, maxEntries);
  trimCacheEntries(
    previewImageAssetCache,
    keepPaths,
    Math.min(maxEntries, MAX_PREVIEW_CACHE_ENTRIES)
  );
  imageWorkScheduler.cancelQueued(
    (task) =>
      (task.priority === IMAGE_WORK_PRIORITY.backgroundPreload ||
        task.priority === IMAGE_WORK_PRIORITY.adjacentDirectional) &&
      !keepPaths.has(task.sourcePath) &&
      (task.key.startsWith('preview::') || task.key.startsWith('full::'))
  );
  syncImageAssetTelemetry();
}

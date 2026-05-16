import {
  convertFileSrc,
  generatedImageAssetToUrl,
  getPreviewImage,
  type GeneratedImageAsset,
} from './tauriCommands';
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
  setPreviewAssetCacheBudgetBytesTelemetry,
  setPreviewAssetCacheEstimatedBytesTelemetry,
  setPreviewAssetCacheEntryCountTelemetry,
} from './performanceTelemetry';
import { estimatePreviewAssetBytes } from './cacheMemory';
import { getPerformanceModeProfile } from './performanceMode';
import {
  releaseRetainedDecodedImage,
  retainDecodedImage,
  type RetainedImageHandle,
} from './retainedImage';

type ImageAssetEntry = {
  url: string;
  version: number;
  lastUsedAt: number;
};

type PreviewAssetEntry = {
  url: string;
  version: number;
  maxDimension: number;
  estimatedBytes: number;
  lastUsedAt: number;
  retainedImage?: RetainedImageHandle;
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
let previewCacheBudgetBytes = getPerformanceModeProfile('balanced').previewCacheBudgetBytes;
let previewImageAssetCacheEstimatedBytes = 0;
let latestProtectedPreviewPaths = new Set<string>();
let latestPrimaryProtectedPreviewPath: string | null = null;

function syncImageAssetTelemetry(): void {
  setFullAssetCacheEntryCountTelemetry(fullImageAssetCache.size);
  setPreviewAssetCacheEntryCountTelemetry(previewImageAssetCache.size);
  setPreviewAssetCacheEstimatedBytesTelemetry(previewImageAssetCacheEstimatedBytes);
  setPreviewAssetCacheBudgetBytesTelemetry(previewCacheBudgetBytes);
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

function getLeastRecentlyUsedEntries<T extends { lastUsedAt: number }>(
  cache: Map<string, T>,
  keepPaths: Set<string>
): Array<[string, T]> {
  return Array.from(cache.entries())
    .filter(([path]) => !keepPaths.has(path))
    .sort((a, b) => {
      if (a[1].lastUsedAt !== b[1].lastUsedAt) {
        return a[1].lastUsedAt - b[1].lastUsedAt;
      }
      return a[0].localeCompare(b[0]);
    });
}

function trimCacheEntries<T extends { lastUsedAt: number }>(
  cache: Map<string, T>,
  keepPaths: Set<string>,
  maxEntries: number
): void {
  if (maxEntries < 0 || cache.size <= maxEntries) return;

  for (const [path] of getLeastRecentlyUsedEntries(cache, keepPaths)) {
    if (cache.size <= maxEntries) break;
    cache.delete(path);
  }
}

function normalizeBudgetBytes(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
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

function releasePreviewAssetEntry(entry: PreviewAssetEntry): void {
  releaseRetainedDecodedImage(entry.retainedImage);
}

function retainPreviewAssetEntry(entry: PreviewAssetEntry): void {
  entry.retainedImage = retainDecodedImage(entry.url);
}

function deletePreviewAssetEntry(path: string): void {
  const entry = previewImageAssetCache.get(path);
  if (!entry) {
    return;
  }

  previewImageAssetCache.delete(path);
  previewImageAssetCacheEstimatedBytes -= entry.estimatedBytes;
  releasePreviewAssetEntry(entry);
}

function setPreviewAssetEntry(path: string, entry: PreviewAssetEntry): void {
  deletePreviewAssetEntry(path);
  previewImageAssetCache.set(path, entry);
  previewImageAssetCacheEstimatedBytes += entry.estimatedBytes;
}

function prunePreviewAssetEntries(keepPaths: Set<string>): void {
  for (const path of previewImageAssetCache.keys()) {
    if (!keepPaths.has(path)) {
      deletePreviewAssetEntry(path);
    }
  }
}

function firstSetValue(values: Set<string>): string | null {
  const first = values.values().next();
  return first.done ? null : first.value;
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

function createPreviewAssetEntry(
  asset: GeneratedImageAsset,
  version: number,
  maxDimension: number
): PreviewAssetEntry {
  const url = generatedImageAssetToUrl(asset);
  return {
    url,
    version,
    maxDimension,
    estimatedBytes: estimatePreviewAssetBytes({
      maxDimension,
      url,
      width: asset.width,
      height: asset.height,
    }),
    lastUsedAt: Date.now(),
  };
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
    releasePreviewAssetEntry(entry);
    syncImageAssetTelemetry();
    return entry.url;
  }

  const current = previewImageAssetCache.get(path);
  if (current && current.version >= entry.version && current.maxDimension === entry.maxDimension) {
    releasePreviewAssetEntry(entry);
    current.lastUsedAt = Date.now();
    recordPreviewAssetCacheHit();
    syncImageAssetTelemetry();
    return current.url;
  }

  retainPreviewAssetEntry(entry);
  setPreviewAssetEntry(path, entry);
  if (entry.version > 0) {
    latestMutationVersions.set(path, entry.version);
  }
  if (pendingInvalidations.get(path) === entry.version) {
    pendingInvalidations.delete(path);
  }

  const protectedPaths = new Set(latestProtectedPreviewPaths);
  protectedPaths.add(path);
  enforcePreviewBudget(protectedPaths);
  syncImageAssetTelemetry();
  return entry.url;
}

function enforcePreviewBudget(keepPaths: Set<string>): void {
  if (previewImageAssetCacheEstimatedBytes <= previewCacheBudgetBytes) {
    return;
  }

  for (const [path] of getLeastRecentlyUsedEntries(previewImageAssetCache, keepPaths)) {
    if (previewImageAssetCacheEstimatedBytes <= previewCacheBudgetBytes) {
      break;
    }

    deletePreviewAssetEntry(path);
  }
}

export function configureImageAssetCache(options: { previewCacheBudgetBytes?: number }): void {
  const previousBudgetBytes = previewCacheBudgetBytes;
  previewCacheBudgetBytes = normalizeBudgetBytes(
    options.previewCacheBudgetBytes ?? previewCacheBudgetBytes,
    previewCacheBudgetBytes
  );
  const protectedPaths =
    previewCacheBudgetBytes < previousBudgetBytes
      ? new Set(latestPrimaryProtectedPreviewPath ? [latestPrimaryProtectedPreviewPath] : [])
      : latestProtectedPreviewPaths;
  latestProtectedPreviewPaths = new Set(protectedPaths);
  enforcePreviewBudget(protectedPaths);
  syncImageAssetTelemetry();
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
      let entry = createPreviewAssetEntry(
        await measurePerformanceSpan('previewGeneration', () =>
          getPreviewImage(path, maxDimension, initialBust)
        ),
        initialVersion,
        maxDimension
      );

      const resolvedVersion = Math.max(initialVersion, currentVersion(path));
      if (resolvedVersion !== entry.version) {
        releasePreviewAssetEntry(entry);
        const resolvedBust = resolvedVersion > 0 ? resolvedVersion : undefined;
        entry = createPreviewAssetEntry(
          await measurePerformanceSpan('previewGeneration', () =>
            getPreviewImage(path, maxDimension, resolvedBust)
          ),
          resolvedVersion,
          maxDimension
        );
      }

      if (signal.aborted) {
        releasePreviewAssetEntry(entry);
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

  await loadPreviewAssetWithPriority(
    path,
    maxDimension,
    options?.priority ?? IMAGE_WORK_PRIORITY.backgroundPreload,
    options
  );
}

export function invalidateImageAsset(path: string): void {
  const version = Date.now();
  pendingInvalidations.set(path, version);
  latestMutationVersions.set(path, version);

  imageWorkScheduler.cancelQueued((job) => job.sourcePath === path);
  fullImageAssetCache.delete(path);
  deletePreviewAssetEntry(path);
  syncImageAssetTelemetry();
}

export function trimImageAssetCache(
  keepPaths: Set<string>,
  maxEntries: number,
  options?: CacheTrimOptions
): void {
  if (options?.pruneMissing) {
    maybePruneEntries(fullImageAssetCache, keepPaths);
    prunePreviewAssetEntries(keepPaths);
  }

  if (Number.isFinite(maxEntries)) {
    latestProtectedPreviewPaths = new Set(keepPaths);
    latestPrimaryProtectedPreviewPath = firstSetValue(keepPaths);
  }

  trimCacheEntries(fullImageAssetCache, keepPaths, maxEntries);
  enforcePreviewBudget(latestProtectedPreviewPaths);
  imageWorkScheduler.cancelQueued(
    (task) =>
      (task.priority === IMAGE_WORK_PRIORITY.backgroundPreload ||
        task.priority === IMAGE_WORK_PRIORITY.adjacentDirectional) &&
      !keepPaths.has(task.sourcePath) &&
      (task.key.startsWith('preview::') || task.key.startsWith('full::'))
  );
  syncImageAssetTelemetry();
}

import {
  cancelMediaRequest,
  generatedImageAssetToUrl,
  getPreviewImage,
  getPreviewImageById,
  getSessionAssetUrl,
  releaseSessionAssetDelivery,
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
  path: string;
  url: string;
  version: number;
  lastUsedAt: number;
  sessionId: string;
  imageId: string;
};

type PreviewAssetEntry = {
  path: string;
  sessionId: string;
  imageId: string;
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
  requestId?: string;
};

type ScheduledCacheReadOptions = CacheReadOptions & {
  priority?: ImageWorkPriority;
};

type CacheTrimOptions = {
  pruneMissing?: boolean;
  pruneMissingPaths?: Set<string>;
  cancelOutsidePaths?: Set<string>;
};

const fullImageAssetCache = new Map<string, ImageAssetEntry>();
let fullDeliveryRequestSequence = 0;
const previewImageAssetCache = new Map<string, PreviewAssetEntry>();
const pendingInvalidations = new Map<string, number>();
const latestMutationVersions = new Map<string, number>();
const activeMutationVersionRefs = new Map<string, number>();
const MAX_MUTATION_VERSION_ENTRIES = 2048;
const PRUNED_MUTATION_BUCKET_COUNT = 65_536;
const prunedMutationVersionBucketsA = new Float64Array(PRUNED_MUTATION_BUCKET_COUNT);
const prunedMutationVersionBucketsB = new Float64Array(PRUNED_MUTATION_BUCKET_COUNT);
const DEFAULT_PREVIEW_MAX_DIMENSION = 2048;
let previewCacheBudgetBytes = getPerformanceModeProfile('balanced').previewCacheBudgetBytes;
let previewImageAssetCacheEstimatedBytes = 0;
let latestProtectedPreviewPaths = new Set<string>();
let latestPrimaryProtectedPreviewPath: string | null = null;
let mutationGeneration = 0;

function nextMutationGeneration(): number {
  // Date.now() alone is not a generation: multiple mutations in one clock tick (or while the
  // clock is adjusted backwards) would otherwise reuse an asset URL and admit stale work.
  mutationGeneration = Math.max(mutationGeneration + 1, Date.now());
  return mutationGeneration;
}

function syncImageAssetTelemetry(): void {
  setFullAssetCacheEntryCountTelemetry(fullImageAssetCache.size);
  setPreviewAssetCacheEntryCountTelemetry(previewImageAssetCache.size);
  setPreviewAssetCacheEstimatedBytesTelemetry(previewImageAssetCacheEstimatedBytes);
  setPreviewAssetCacheBudgetBytesTelemetry(previewCacheBudgetBytes);
}

function releaseCachedFullAssetEntry(entry: ImageAssetEntry): void {
  if (entry.url) void releaseSessionAssetDelivery(entry.url);
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

function currentVersion(path: string): number {
  const [bucketA, bucketB] = mutationBuckets(path);
  const prunedVersion = Math.min(
    prunedMutationVersionBucketsA[bucketA] ?? 0,
    prunedMutationVersionBucketsB[bucketB] ?? 0
  );
  return Math.max(
    prunedVersion,
    pendingInvalidations.get(path) ?? 0,
    latestMutationVersions.get(path) ?? 0
  );
}

function mutationBuckets(path: string): [number, number] {
  let hashA = 2166136261;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 16777619);
    hashB = Math.imul(hashB ^ code, 2246822519) ^ (hashB >>> 13);
  }
  return [
    (hashA >>> 0) % PRUNED_MUTATION_BUCKET_COUNT,
    (hashB >>> 0) % PRUNED_MUTATION_BUCKET_COUNT,
  ];
}

function mutationRefKey(path: string, version: number): string {
  return `${path}\u0000${version}`;
}

function retainMutationVersion(path: string, version: number): void {
  const key = mutationRefKey(path, version);
  activeMutationVersionRefs.set(key, (activeMutationVersionRefs.get(key) ?? 0) + 1);
}

function releaseMutationVersion(path: string, version: number): void {
  const key = mutationRefKey(path, version);
  const count = activeMutationVersionRefs.get(key) ?? 0;
  if (count <= 1) activeMutationVersionRefs.delete(key);
  else activeMutationVersionRefs.set(key, count - 1);
}

function pruneMutationVersionHistory(): void {
  if (latestMutationVersions.size <= MAX_MUTATION_VERSION_ENTRIES) return;
  const candidates = Array.from(latestMutationVersions.entries())
    .filter(([path]) => {
      const hasActiveRequest = Array.from(activeMutationVersionRefs.keys()).some((key) =>
        key.startsWith(`${path}\u0000`)
      );
      const hasCachedAsset =
        Array.from(fullImageAssetCache.values()).some((entry) => entry.path === path) ||
        Array.from(previewImageAssetCache.values()).some((entry) => entry.path === path);
      return !hasActiveRequest && !hasCachedAsset;
    })
    .sort(([, left], [, right]) => left - right);
  for (const [path] of candidates) {
    if (latestMutationVersions.size <= MAX_MUTATION_VERSION_ENTRIES) break;
    const version = latestMutationVersions.get(path) ?? 0;
    const [bucketA, bucketB] = mutationBuckets(path);
    prunedMutationVersionBucketsA[bucketA] = Math.max(
      prunedMutationVersionBucketsA[bucketA] ?? 0,
      version
    );
    prunedMutationVersionBucketsB[bucketB] = Math.max(
      prunedMutationVersionBucketsB[bucketB] ?? 0,
      version
    );
    latestMutationVersions.delete(path);
    pendingInvalidations.delete(path);
  }
}

// Test-only cardinality inspector for the bounded stale-result history.
// fallow-ignore-next-line unused-export -- deterministic cache retention tests
export function getImageAssetCacheVersionEntryCountForTests(): number {
  return latestMutationVersions.size;
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

function fullAssetCacheKey(
  path: string,
  sessionId: string,
  imageId: string,
  version: number
): string {
  return `${sessionId}\u0000${imageId}\u0000${path}\u0000${version}`;
}

function deleteFullAssetsForPath(path: string): void {
  for (const [key, entry] of fullImageAssetCache) {
    if (entry.path === path) {
      fullImageAssetCache.delete(key);
      releaseCachedFullAssetEntry(entry);
    }
  }
}

function pruneFullAssetEntries(keepPaths: Set<string>): void {
  for (const [key, entry] of fullImageAssetCache) {
    if (!keepPaths.has(entry.path)) {
      fullImageAssetCache.delete(key);
      releaseCachedFullAssetEntry(entry);
    }
  }
}

function trimFullAssetEntries(keepPaths: Set<string>, maxEntries: number): void {
  if (maxEntries < 0 || fullImageAssetCache.size <= maxEntries) return;
  const candidates = Array.from(fullImageAssetCache.entries())
    .filter(([, entry]) => !keepPaths.has(entry.path))
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
  for (const [key, entry] of candidates) {
    if (fullImageAssetCache.size <= maxEntries) break;
    fullImageAssetCache.delete(key);
    releaseCachedFullAssetEntry(entry);
  }
}

function releasePreviewAssetEntry(entry: PreviewAssetEntry): void {
  releaseRetainedDecodedImage(entry.retainedImage);
}

function retainPreviewAssetEntry(entry: PreviewAssetEntry): void {
  entry.retainedImage = retainDecodedImage(entry.url);
}

function deletePreviewAssetEntry(path: string): void {
  for (const [key, entry] of previewImageAssetCache) {
    if (entry.path !== path) continue;
    previewImageAssetCache.delete(key);
    previewImageAssetCacheEstimatedBytes -= entry.estimatedBytes;
    releasePreviewAssetEntry(entry);
  }
}

function previewAssetCacheKey(path: string, sessionId?: string, imageId?: string): string {
  return `${sessionId ?? 'legacy'}\u0000${imageId ?? 'legacy'}\u0000${path}`;
}

function setPreviewAssetEntry(key: string, entry: PreviewAssetEntry): void {
  const previous = previewImageAssetCache.get(key);
  if (previous) {
    previewImageAssetCacheEstimatedBytes -= previous.estimatedBytes;
    releasePreviewAssetEntry(previous);
  }
  previewImageAssetCache.set(key, entry);
  previewImageAssetCacheEstimatedBytes += entry.estimatedBytes;
}

function prunePreviewAssetEntries(keepPaths: Set<string>): void {
  for (const [key, entry] of previewImageAssetCache) {
    if (!keepPaths.has(entry.path)) {
      previewImageAssetCache.delete(key);
      previewImageAssetCacheEstimatedBytes -= entry.estimatedBytes;
      releasePreviewAssetEntry(entry);
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

function createPreviewAssetEntry(
  asset: GeneratedImageAsset,
  path: string,
  sessionId: string | undefined,
  imageId: string | undefined,
  version: number,
  maxDimension: number
): PreviewAssetEntry {
  const url = generatedImageAssetToUrl(asset);
  return {
    path,
    sessionId: sessionId ?? 'legacy',
    imageId: imageId ?? 'legacy',
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

function fullAssetWorkKey(
  path: string,
  sessionId: string,
  imageId: string,
  version: number
): string {
  return `full::${sessionId}::${imageId}::${path}::${version}`;
}

function previewAssetWorkKey(
  path: string,
  sessionId: string | undefined,
  imageId: string | undefined,
  maxDimension: number,
  version: number
): string {
  return `preview::${sessionId ?? 'legacy'}::${imageId ?? 'legacy'}::${path}::${maxDimension}::${version}`;
}

function workScope(priority: ImageWorkPriority): 'interactive' | 'background' {
  return priority === IMAGE_WORK_PRIORITY.currentPreview ||
    priority === IMAGE_WORK_PRIORITY.currentFull
    ? 'interactive'
    : 'background';
}

function scopedFullAssetWorkKey(
  path: string,
  sessionId: string,
  imageId: string,
  version: number,
  priority: ImageWorkPriority
): string {
  return `${fullAssetWorkKey(path, sessionId, imageId, version)}::${workScope(priority)}`;
}

function scopedPreviewAssetWorkKey(
  path: string,
  sessionId: string | undefined,
  imageId: string | undefined,
  maxDimension: number,
  version: number,
  priority: ImageWorkPriority
): string {
  return `${previewAssetWorkKey(path, sessionId, imageId, maxDimension, version)}::${workScope(priority)}`;
}

function storeFullAsset(path: string, entry: ImageAssetEntry, options?: CacheReadOptions): string {
  if (!shouldStore(options)) {
    syncImageAssetTelemetry();
    return entry.url;
  }

  const key = fullAssetCacheKey(path, entry.sessionId, entry.imageId, entry.version);
  const current = fullImageAssetCache.get(key);
  if (current && current.version >= entry.version) {
    current.lastUsedAt = Date.now();
    recordFullAssetCacheHit();
    syncImageAssetTelemetry();
    return entry.url;
  }

  if (current) {
    releaseCachedFullAssetEntry(current);
  }
  // The cache records reusable readiness only. Delivery URLs remain exclusively owned by the
  // caller that receives them and are never published into shared cache state.
  fullImageAssetCache.set(key, { ...entry, url: '' });
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
  cacheKey: string,
  entry: PreviewAssetEntry,
  options?: CacheReadOptions
): string {
  if (!shouldStore(options)) {
    releasePreviewAssetEntry(entry);
    syncImageAssetTelemetry();
    return entry.url;
  }

  const current = previewImageAssetCache.get(cacheKey);
  if (current && current.version >= entry.version && current.maxDimension === entry.maxDimension) {
    releasePreviewAssetEntry(entry);
    current.lastUsedAt = Date.now();
    recordPreviewAssetCacheHit();
    syncImageAssetTelemetry();
    return current.url;
  }

  retainPreviewAssetEntry(entry);
  setPreviewAssetEntry(cacheKey, entry);
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

  const candidates = Array.from(previewImageAssetCache.entries())
    .filter(([, entry]) => !keepPaths.has(entry.path))
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
  for (const [key, entry] of candidates) {
    if (previewImageAssetCacheEstimatedBytes <= previewCacheBudgetBytes) {
      break;
    }

    previewImageAssetCache.delete(key);
    previewImageAssetCacheEstimatedBytes -= entry.estimatedBytes;
    releasePreviewAssetEntry(entry);
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

async function createCacheEntry(
  sessionId: string,
  imageId: string,
  version: number
): Promise<ImageAssetEntry> {
  const baseUrl = await getSessionAssetUrl(sessionId, imageId);
  return {
    path: '',
    url: applyVersionToUrl(baseUrl, version),
    version,
    lastUsedAt: Date.now(),
    sessionId,
    imageId,
  };
}

async function loadFullAssetWithPriority(
  path: string,
  priority: ImageWorkPriority,
  options?: CacheReadOptions,
  sessionId?: string,
  imageId?: string
): Promise<string> {
  if (!sessionId || !imageId) {
    throw new Error('Full resolution asset request requires authorized sessionId and id');
  }

  const version = currentVersion(path);
  const cacheKey = fullAssetCacheKey(path, sessionId, imageId, version);
  const cached = fullImageAssetCache.get(cacheKey);
  if (
    cached &&
    cached.version === version &&
    cached.sessionId === sessionId &&
    cached.imageId === imageId
  ) {
    const replacementUrl = applyVersionToUrl(await getSessionAssetUrl(sessionId, imageId), version);
    if (options?.signal?.aborted) {
      void releaseSessionAssetDelivery(replacementUrl);
      throw createAbortError('Full asset work aborted after delivery mint.');
    }
    // Each full-asset URL represents one backend delivery and belongs to the caller receiving it.
    // A cache hit therefore must not replace or release another caller's still-live delivery.
    cached.lastUsedAt = Date.now();
    recordFullAssetCacheHit();
    syncImageAssetTelemetry();
    return replacementUrl;
  }

  retainMutationVersion(path, version);
  return imageWorkScheduler
    .schedule({
      key: `${scopedFullAssetWorkKey(path, sessionId, imageId, version, priority)}::delivery_${++fullDeliveryRequestSequence}`,
      priority,
      sourcePath: path,
      generationToken: version,
      signal: options?.signal,
      run: async ({ signal }) => {
        if (signal.aborted) {
          throw createAbortError('Full asset work aborted before execution.');
        }

        recordFullAssetCacheMiss();
        const entry = { ...(await createCacheEntry(sessionId, imageId, version)), path };
        try {
          if (currentVersion(path) > entry.version) {
            throw new Error(`Full asset for '${path}' superseded by concurrent mutation.`);
          }
          if (signal.aborted) {
            throw createAbortError('Full asset work aborted before cache publication.');
          }

          return storeFullAsset(path, entry, options);
        } catch (error) {
          void releaseSessionAssetDelivery(entry.url);
          throw error;
        }
      },
    })
    .promise.finally(() => {
      releaseMutationVersion(path, version);
      pruneMutationVersionHistory();
    });
}

async function loadPreviewAssetWithPriority(
  path: string,
  maxDimension: number,
  priority: ImageWorkPriority,
  options?: CacheReadOptions,
  sessionId?: string,
  imageId?: string
): Promise<string> {
  const version = currentVersion(path);
  const cacheKey = previewAssetCacheKey(path, sessionId, imageId);
  const existing = previewImageAssetCache.get(cacheKey);
  if (existing && existing.version === version && existing.maxDimension === maxDimension) {
    existing.lastUsedAt = Date.now();
    recordPreviewAssetCacheHit();
    syncImageAssetTelemetry();
    return existing.url;
  }

  retainMutationVersion(path, version);
  return imageWorkScheduler
    .schedule({
      key: scopedPreviewAssetWorkKey(path, sessionId, imageId, maxDimension, version, priority),
      priority,
      sourcePath: path,
      generationToken: version,
      signal: options?.signal,
      run: async ({ signal }) => {
        // The request ID belongs to the coalesced physical job, not to whichever consumer happened
        // to schedule it first. The scheduler aborts this signal only after the final consumer has
        // detached, so one consumer can no longer cancel work still needed by another.
        const requestId =
          options?.requestId ?? `req_prev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const onAbort = () => {
          void cancelMediaRequest(requestId).catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          throw createAbortError('Preview work aborted before execution.');
        }

        recordPreviewAssetCacheMiss();
        const initialVersion = currentVersion(path);
        const initialBust = initialVersion > 0 ? initialVersion : undefined;

        try {
          let entry = createPreviewAssetEntry(
            await measurePerformanceSpan('previewGeneration', () =>
              sessionId && imageId
                ? getPreviewImageById(sessionId, imageId, maxDimension, initialBust, requestId)
                : getPreviewImage(path, maxDimension, initialBust, requestId)
            ),
            path,
            sessionId,
            imageId,
            initialVersion,
            maxDimension
          );

          const resolvedVersion = Math.max(initialVersion, currentVersion(path));
          if (resolvedVersion !== entry.version) {
            releasePreviewAssetEntry(entry);
            const resolvedBust = resolvedVersion > 0 ? resolvedVersion : undefined;
            entry = createPreviewAssetEntry(
              await measurePerformanceSpan('previewGeneration', () =>
                sessionId && imageId
                  ? getPreviewImageById(sessionId, imageId, maxDimension, resolvedBust, requestId)
                  : getPreviewImage(path, maxDimension, resolvedBust, requestId)
              ),
              path,
              sessionId,
              imageId,
              resolvedVersion,
              maxDimension
            );
          }

          if (currentVersion(path) > entry.version) {
            releasePreviewAssetEntry(entry);
            throw new Error(`Preview asset for '${path}' superseded by concurrent mutation.`);
          }
          if (signal.aborted) {
            releasePreviewAssetEntry(entry);
            throw createAbortError('Preview work aborted before cache publication.');
          }

          return storePreviewAsset(path, cacheKey, entry, options);
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
    })
    .promise.finally(() => {
      releaseMutationVersion(path, version);
      pruneMutationVersionHistory();
    });
}

export function requestFullAsset(
  image: { path: string; sessionId: string; id: string },
  options?: CacheReadOptions
): Promise<string> {
  if (!image || !image.sessionId || !image.id) {
    return Promise.reject(
      new Error('Full resolution asset request requires authorized sessionId and id')
    );
  }
  return loadFullAssetWithPriority(
    image.path,
    IMAGE_WORK_PRIORITY.currentFull,
    options,
    image.sessionId,
    image.id
  );
}

export async function getPreviewAsset(
  pathOrImage: string | { path: string; sessionId?: string; id?: string },
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  options?: CacheReadOptions
): Promise<string> {
  const path = typeof pathOrImage === 'string' ? pathOrImage : pathOrImage.path;
  return loadPreviewAssetWithPriority(
    path,
    maxDimension,
    IMAGE_WORK_PRIORITY.currentPreview,
    options,
    typeof pathOrImage === 'string' ? undefined : pathOrImage.sessionId,
    typeof pathOrImage === 'string' ? undefined : pathOrImage.id
  );
}

export async function preloadFullAsset(
  image: { path: string; sessionId: string; id: string },
  options?: ScheduledCacheReadOptions
): Promise<void> {
  if (!shouldStore(options) || !image || !image.sessionId || !image.id) {
    return;
  }

  let deliveryUrl: string | undefined;
  try {
    deliveryUrl = await loadFullAssetWithPriority(
      image.path,
      options?.priority ?? IMAGE_WORK_PRIORITY.adjacentDirectional,
      options,
      image.sessionId,
      image.id
    );
  } finally {
    if (deliveryUrl) {
      await releaseSessionAssetDelivery(deliveryUrl).catch(() => {});
    }
  }
}

export async function preloadPreviewAsset(
  pathOrImage: string | { path: string; sessionId?: string; id?: string },
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  options?: ScheduledCacheReadOptions
): Promise<void> {
  if (!shouldStore(options)) {
    return;
  }

  const path = typeof pathOrImage === 'string' ? pathOrImage : pathOrImage.path;

  await loadPreviewAssetWithPriority(
    path,
    maxDimension,
    options?.priority ?? IMAGE_WORK_PRIORITY.backgroundPreload,
    options,
    typeof pathOrImage === 'string' ? undefined : pathOrImage.sessionId,
    typeof pathOrImage === 'string' ? undefined : pathOrImage.id
  );
}

export function invalidateImageAsset(path: string): void {
  const version = nextMutationGeneration();
  pendingInvalidations.set(path, version);
  latestMutationVersions.set(path, version);

  imageWorkScheduler.cancelQueued((job) => job.sourcePath === path);
  deleteFullAssetsForPath(path);
  deletePreviewAssetEntry(path);
  syncImageAssetTelemetry();
  pruneMutationVersionHistory();
}

export function trimImageAssetCache(
  keepPaths: Set<string>,
  maxEntries: number,
  options?: CacheTrimOptions
): void {
  if (options?.pruneMissing) {
    const prunePaths = options.pruneMissingPaths ?? keepPaths;
    pruneFullAssetEntries(prunePaths);
    prunePreviewAssetEntries(prunePaths);
  }

  if (Number.isFinite(maxEntries)) {
    latestProtectedPreviewPaths = new Set(keepPaths);
    latestPrimaryProtectedPreviewPath = firstSetValue(keepPaths);
  }

  trimFullAssetEntries(keepPaths, maxEntries);
  enforcePreviewBudget(latestProtectedPreviewPaths);
  const cancelKeepPaths = options?.cancelOutsidePaths ?? keepPaths;
  imageWorkScheduler.cancelQueued(
    (task) =>
      (task.priority === IMAGE_WORK_PRIORITY.backgroundPreload ||
        task.priority === IMAGE_WORK_PRIORITY.adjacentDirectional) &&
      !cancelKeepPaths.has(task.sourcePath) &&
      (task.key.startsWith('preview::') || task.key.startsWith('full::'))
  );
  syncImageAssetTelemetry();
  pruneMutationVersionHistory();
}

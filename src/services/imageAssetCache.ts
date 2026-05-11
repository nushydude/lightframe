import { convertFileSrc, getPreviewImage } from './tauriCommands';

type ImageAssetEntry = {
  url: string;
  version: number;
  lastUsedAt: number;
};

type PreviewAssetEntry = {
  dataUrl: string;
  version: number;
  maxDimension: number;
  lastUsedAt: number;
};

type CacheStoreGuard = () => boolean;

type CacheReadOptions = {
  canStore?: CacheStoreGuard;
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

export function getFullAsset(path: string, options?: CacheReadOptions): string {
  const existing = fullImageAssetCache.get(path);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.url;
  }

  const startVersion = currentVersion(path);
  const entry = createCacheEntry(path, startVersion);

  const resolvedVersion = Math.max(startVersion, currentVersion(path));
  if (resolvedVersion !== entry.version) {
    entry.version = resolvedVersion;
    entry.url = applyVersionToUrl(entry.url, resolvedVersion);
  }

  if (!shouldStore(options)) {
    return entry.url;
  }

  const current = fullImageAssetCache.get(path);
  if (current && current.version >= entry.version) {
    current.lastUsedAt = Date.now();
    return current.url;
  }

  fullImageAssetCache.set(path, entry);
  if (entry.version > 0) {
    latestMutationVersions.set(path, entry.version);
  }

  // Only clear the pending marker if we just consumed that exact version.
  if (pendingInvalidations.get(path) === entry.version) {
    pendingInvalidations.delete(path);
  }

  return entry.url;
}

export async function getPreviewAsset(
  path: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  options?: CacheReadOptions
): Promise<string> {
  const version = currentVersion(path);
  const existing = previewImageAssetCache.get(path);
  if (existing && existing.version === version && existing.maxDimension === maxDimension) {
    existing.lastUsedAt = Date.now();
    return existing.dataUrl;
  }

  let entry: PreviewAssetEntry = {
    dataUrl: await getPreviewImage(path, maxDimension),
    version,
    maxDimension,
    lastUsedAt: Date.now(),
  };

  const resolvedVersion = Math.max(version, currentVersion(path));
  if (resolvedVersion !== entry.version) {
    entry = {
      dataUrl: await getPreviewImage(path, maxDimension),
      version: resolvedVersion,
      maxDimension,
      lastUsedAt: Date.now(),
    };
  }

  if (!shouldStore(options)) {
    return entry.dataUrl;
  }

  const current = previewImageAssetCache.get(path);
  if (current && current.version >= entry.version && current.maxDimension === entry.maxDimension) {
    current.lastUsedAt = Date.now();
    return current.dataUrl;
  }

  previewImageAssetCache.set(path, entry);
  if (entry.version > 0) {
    latestMutationVersions.set(path, entry.version);
  }
  if (pendingInvalidations.get(path) === entry.version) {
    pendingInvalidations.delete(path);
  }

  trimCacheEntries(previewImageAssetCache, new Set([path]), MAX_PREVIEW_CACHE_ENTRIES);
  return entry.dataUrl;
}

export async function preloadFullAsset(path: string, options?: CacheReadOptions): Promise<void> {
  if (!shouldStore(options)) {
    return;
  }

  const url = getFullAsset(path, options);
  if (!shouldStore(options)) {
    return;
  }

  const img = new Image();
  img.src = url;
}

export async function preloadPreviewAsset(
  path: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  options?: CacheReadOptions
): Promise<void> {
  if (!shouldStore(options)) {
    return;
  }

  const dataUrl = await getPreviewAsset(path, maxDimension, options);
  if (!shouldStore(options)) {
    return;
  }

  const img = new Image();
  img.src = dataUrl;
}

export function invalidateImageAsset(path: string): void {
  const version = Date.now();
  pendingInvalidations.set(path, version);
  latestMutationVersions.set(path, version);

  fullImageAssetCache.delete(path);
  previewImageAssetCache.delete(path);
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
}

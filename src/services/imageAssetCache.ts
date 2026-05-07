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

  try {
    const parsed = new URL(url);
    parsed.searchParams.set('v', String(version));
    return parsed.toString();
  } catch {
    const hashIndex = url.indexOf('#');
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const [pathPart, queryPart = ''] = base.split('?', 2);
    const params = new URLSearchParams(queryPart);
    params.set('v', String(version));
    const query = params.toString();
    return `${pathPart}${query ? `?${query}` : ''}${hash}`;
  }
}

function removeVersionFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('v');
    return parsed.toString();
  } catch {
    const hashIndex = url.indexOf('#');
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const [pathPart, queryPart = ''] = base.split('?', 2);
    const params = new URLSearchParams(queryPart);
    params.delete('v');
    const query = params.toString();
    return `${pathPart}${query ? `?${query}` : ''}${hash}`;
  }
}

async function createCacheEntry(path: string, version: number): Promise<ImageAssetEntry> {
  const baseUrl = await convertFileSrc(path);
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

export async function getFullAsset(path: string): Promise<string> {
  const existing = fullImageAssetCache.get(path);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.url;
  }

  const startVersion = currentVersion(path);
  const entry = await createCacheEntry(path, startVersion);

  const resolvedVersion = Math.max(startVersion, currentVersion(path));
  if (resolvedVersion !== entry.version) {
    entry.version = resolvedVersion;
    entry.url = applyVersionToUrl(entry.url, resolvedVersion);
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

export async function getImageAssetUrl(path: string): Promise<string> {
  return getFullAsset(path);
}

export async function getPreviewAsset(
  path: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION
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

  const current = previewImageAssetCache.get(path);
  if (
    current &&
    current.version >= entry.version &&
    current.maxDimension === entry.maxDimension
  ) {
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

export async function preloadFullAsset(path: string): Promise<void> {
  const url = await getFullAsset(path);
  const img = new Image();
  img.src = url;
}

export async function preloadPreviewAsset(
  path: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION
): Promise<void> {
  const dataUrl = await getPreviewAsset(path, maxDimension);
  const img = new Image();
  img.src = dataUrl;
}

export async function preloadImageAsset(path: string): Promise<void> {
  return preloadFullAsset(path);
}

export function invalidateImageAsset(path: string): void {
  const version = Date.now();
  pendingInvalidations.set(path, version);
  latestMutationVersions.set(path, version);

  previewImageAssetCache.delete(path);

  const existing = fullImageAssetCache.get(path);
  if (!existing) return;

  existing.version = version;
  existing.url = applyVersionToUrl(existing.url, version);
  existing.lastUsedAt = Date.now();
}

export function trimImageAssetCache(keepPaths: Set<string>, maxEntries: number): void {
  trimCacheEntries(fullImageAssetCache, keepPaths, maxEntries);
  trimCacheEntries(
    previewImageAssetCache,
    keepPaths,
    Math.min(maxEntries, MAX_PREVIEW_CACHE_ENTRIES)
  );
}

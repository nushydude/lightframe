import { convertFileSrc } from './tauriCommands';

type ImageAssetEntry = {
  url: string;
  version: number;
  lastUsedAt: number;
};

const imageAssetCache = new Map<string, ImageAssetEntry>();
const pendingInvalidations = new Map<string, number>();
const latestMutationVersions = new Map<string, number>();

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

export async function getImageAssetUrl(path: string): Promise<string> {
  const existing = imageAssetCache.get(path);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.url;
  }

  const startVersion = Math.max(
    pendingInvalidations.get(path) ?? 0,
    latestMutationVersions.get(path) ?? 0
  );
  const entry = await createCacheEntry(path, startVersion);

  const resolvedVersion = Math.max(
    startVersion,
    pendingInvalidations.get(path) ?? 0,
    latestMutationVersions.get(path) ?? 0
  );
  if (resolvedVersion !== entry.version) {
    entry.version = resolvedVersion;
    entry.url = applyVersionToUrl(entry.url, resolvedVersion);
  }

  const current = imageAssetCache.get(path);
  if (current && current.version >= entry.version) {
    current.lastUsedAt = Date.now();
    return current.url;
  }

  imageAssetCache.set(path, entry);
  if (entry.version > 0) {
    latestMutationVersions.set(path, entry.version);
  }

  // Only clear the pending marker if we just consumed that exact version.
  if (pendingInvalidations.get(path) === entry.version) {
    pendingInvalidations.delete(path);
  }

  return entry.url;
}

export async function preloadImageAsset(path: string): Promise<void> {
  const url = await getImageAssetUrl(path);
  const img = new Image();
  img.src = url;
}

export function invalidateImageAsset(path: string): void {
  const version = Date.now();
  pendingInvalidations.set(path, version);
  latestMutationVersions.set(path, version);

  const existing = imageAssetCache.get(path);
  if (!existing) return;

  existing.version = version;
  existing.url = applyVersionToUrl(existing.url, version);
  existing.lastUsedAt = Date.now();
}

export function trimImageAssetCache(keepPaths: Set<string>, maxEntries: number): void {
  if (maxEntries < 0 || imageAssetCache.size <= maxEntries) return;

  const evictable = Array.from(imageAssetCache.entries())
    .filter(([path]) => !keepPaths.has(path))
    .sort((a, b) => {
      if (a[1].lastUsedAt !== b[1].lastUsedAt) {
        return a[1].lastUsedAt - b[1].lastUsedAt;
      }
      return a[0].localeCompare(b[0]);
    });

  for (const [path] of evictable) {
    if (imageAssetCache.size <= maxEntries) {
      break;
    }
    imageAssetCache.delete(path);
  }
}

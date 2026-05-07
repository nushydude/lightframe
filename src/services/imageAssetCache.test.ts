import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const convertFileSrcMock = vi.fn(async (path: string) => `asset://localhost/${path}`);
const getPreviewImageMock = vi.fn(
  async (path: string, maxDimension: number) =>
    `data:image/jpeg;base64,preview-${maxDimension}-${path}`
);

vi.mock('./tauriCommands', () => ({
  convertFileSrc: convertFileSrcMock,
  getPreviewImage: getPreviewImageMock,
}));

async function loadCacheModule() {
  return import('./imageAssetCache');
}

describe('imageAssetCache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the same URL for repeated reads before invalidation', async () => {
    const { getImageAssetUrl } = await loadCacheModule();

    const first = await getImageAssetUrl('C:/images/a.jpg');
    const second = await getImageAssetUrl('C:/images/a.jpg');

    expect(first).toBe(second);
    expect(first).not.toContain('v=');
    expect(convertFileSrcMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateImageAsset changes only the invalidated path URL', async () => {
    const { getImageAssetUrl, invalidateImageAsset } = await loadCacheModule();

    const pathA = 'C:/images/a.jpg';
    const pathB = 'C:/images/b.jpg';

    const firstA = await getImageAssetUrl(pathA);
    const firstB = await getImageAssetUrl(pathB);

    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    invalidateImageAsset(pathA);

    const secondA = await getImageAssetUrl(pathA);
    const secondB = await getImageAssetUrl(pathB);

    expect(secondA).not.toBe(firstA);
    expect(secondA).toContain('v=');
    expect(secondB).toBe(firstB);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(2);
  });

  it('applies invalidation version when path is invalidated before first read', async () => {
    const { getImageAssetUrl, invalidateImageAsset } = await loadCacheModule();
    const path = 'C:/images/new.jpg';

    vi.setSystemTime(new Date('2026-01-01T00:00:09.000Z'));
    invalidateImageAsset(path);

    const url = await getImageAssetUrl(path);

    expect(url).toContain('v=1767225609000');
    expect(convertFileSrcMock).toHaveBeenCalledTimes(1);
  });

  it('keeps invalidation version when invalidated during in-flight first read', async () => {
    const { getImageAssetUrl, invalidateImageAsset } = await loadCacheModule();
    const path = 'C:/images/race.jpg';

    let resolveConvert: ((url: string) => void) | undefined;
    convertFileSrcMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveConvert = resolve;
        })
    );

    const pendingUrl = getImageAssetUrl(path);

    vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
    const invalidationVersion = Date.now();
    invalidateImageAsset(path);

    resolveConvert?.(`asset://localhost/${path}`);
    const url = await pendingUrl;

    expect(url).toContain(`v=${invalidationVersion}`);
  });

  it('does not let older concurrent first read overwrite a newer versioned cache entry', async () => {
    const { getImageAssetUrl, invalidateImageAsset } = await loadCacheModule();
    const path = 'C:/images/concurrent-race.jpg';

    let resolveA: ((url: string) => void) | undefined;
    let resolveB: ((url: string) => void) | undefined;

    convertFileSrcMock
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveA = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveB = resolve;
          })
      );

    const firstRead = getImageAssetUrl(path);

    vi.setSystemTime(new Date('2026-01-01T00:00:11.000Z'));
    const invalidationVersion = Date.now();
    invalidateImageAsset(path);

    const secondRead = getImageAssetUrl(path);

    resolveB?.(`asset://localhost/${path}`);
    const versionedUrl = await secondRead;
    expect(versionedUrl).toContain(`v=${invalidationVersion}`);

    resolveA?.(`asset://localhost/${path}`);
    const olderResolvedUrl = await firstRead;
    expect(olderResolvedUrl).toBe(versionedUrl);

    const subsequentUrl = await getImageAssetUrl(path);
    expect(subsequentUrl).toBe(versionedUrl);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(2);
  });

  it('preserves invalidation version across trim eviction for future reads', async () => {
    const { getImageAssetUrl, invalidateImageAsset, trimImageAssetCache } = await loadCacheModule();
    const path = 'C:/images/trim-race.jpg';

    await getImageAssetUrl(path);

    vi.setSystemTime(new Date('2026-01-01T00:00:12.000Z'));
    const invalidationVersion = Date.now();
    invalidateImageAsset(path);

    trimImageAssetCache(new Set(), 0);

    const urlAfterTrim = await getImageAssetUrl(path);
    expect(urlAfterTrim).toContain(`v=${invalidationVersion}`);
  });

  it('trimImageAssetCache keeps requested paths and evicts distant entries deterministically', async () => {
    const { getImageAssetUrl, trimImageAssetCache } = await loadCacheModule();

    const pathA = 'C:/images/a.jpg';
    const pathB = 'C:/images/b.jpg';
    const pathC = 'C:/images/c.jpg';
    const pathD = 'C:/images/d.jpg';

    await getImageAssetUrl(pathA);
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    await getImageAssetUrl(pathB);
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    await getImageAssetUrl(pathC);
    vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'));
    await getImageAssetUrl(pathD);

    expect(convertFileSrcMock).toHaveBeenCalledTimes(4);

    trimImageAssetCache(new Set([pathC]), 2);

    await getImageAssetUrl(pathC);
    await getImageAssetUrl(pathD);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(4);

    await getImageAssetUrl(pathA);
    await getImageAssetUrl(pathB);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(6);
  });

  it('caches preview data URLs and reuses them for repeated reads', async () => {
    const { getPreviewAsset } = await loadCacheModule();
    const path = 'C:/images/preview-a.jpg';

    const first = await getPreviewAsset(path);
    const second = await getPreviewAsset(path);

    expect(first).toBe(second);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateImageAsset clears stale preview cache for that path', async () => {
    const { getPreviewAsset, invalidateImageAsset } = await loadCacheModule();
    const path = 'C:/images/preview-invalidate.jpg';

    await getPreviewAsset(path);
    invalidateImageAsset(path);
    await getPreviewAsset(path);

    expect(getPreviewImageMock).toHaveBeenCalledTimes(2);
  });

  it('keeps preview cache bounded and evicts least-recently-used entries', async () => {
    const { getPreviewAsset } = await loadCacheModule();
    const paths = Array.from({ length: 13 }, (_, i) => `C:/images/preview-${i}.jpg`);

    for (const [index, path] of paths.entries()) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`));
      await getPreviewAsset(path);
    }

    expect(getPreviewImageMock).toHaveBeenCalledTimes(13);

    await getPreviewAsset(paths[0]);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(14);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const convertFileSrcMock = vi.fn((path: string) => `asset://localhost/${path}`);
const getPreviewImageMock = vi.fn(
  async (
    path: string,
    maxDimension: number,
    invalidationBust?: number
  ): Promise<{ file_path: string; cache_key: string }> => ({
    file_path: `C:/cache/preview-${maxDimension}-${path.replace(/[:/]/g, '_')}-${invalidationBust ?? 'base'}.jpg`,
    cache_key: `preview-${maxDimension}-${path}-${invalidationBust ?? 'base'}`,
  })
);

vi.mock('./tauriCommands', () => ({
  convertFileSrc: convertFileSrcMock,
  generatedImageAssetToUrl: (asset: { file_path: string; cache_key: string }) =>
    `${convertFileSrcMock(asset.file_path)}?v=${encodeURIComponent(asset.cache_key)}`,
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
    const { getFullAsset } = await loadCacheModule();

    const first = await getFullAsset('C:/images/a.jpg');
    const second = await getFullAsset('C:/images/a.jpg');

    expect(first).toBe(second);
    expect(first).not.toContain('v=');
    expect(convertFileSrcMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateImageAsset changes only the invalidated path URL', async () => {
    const { getFullAsset, invalidateImageAsset } = await loadCacheModule();

    const pathA = 'C:/images/a.jpg';
    const pathB = 'C:/images/b.jpg';

    const firstA = await getFullAsset(pathA);
    const firstB = await getFullAsset(pathB);

    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    invalidateImageAsset(pathA);

    const secondA = await getFullAsset(pathA);
    const secondB = await getFullAsset(pathB);

    expect(secondA).not.toBe(firstA);
    expect(secondA).toContain('v=');
    expect(secondB).toBe(firstB);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(3);
  });

  it('applies invalidation version when path is invalidated before first read', async () => {
    const { getFullAsset, invalidateImageAsset } = await loadCacheModule();
    const path = 'C:/images/new.jpg';

    vi.setSystemTime(new Date('2026-01-01T00:00:09.000Z'));
    invalidateImageAsset(path);

    const url = await getFullAsset(path);

    expect(url).toContain('v=1767225609000');
    expect(convertFileSrcMock).toHaveBeenCalledTimes(1);
  });

  it('preserves invalidation version across trim eviction for future reads', async () => {
    const { getFullAsset, invalidateImageAsset, trimImageAssetCache } = await loadCacheModule();
    const path = 'C:/images/trim-race.jpg';

    await getFullAsset(path);

    vi.setSystemTime(new Date('2026-01-01T00:00:12.000Z'));
    const invalidationVersion = Date.now();
    invalidateImageAsset(path);

    trimImageAssetCache(new Set(), 0);

    const urlAfterTrim = await getFullAsset(path);
    expect(urlAfterTrim).toContain(`v=${invalidationVersion}`);
  });

  it('trimImageAssetCache keeps requested paths and evicts distant entries deterministically', async () => {
    const { getFullAsset, trimImageAssetCache } = await loadCacheModule();

    const pathA = 'C:/images/a.jpg';
    const pathB = 'C:/images/b.jpg';
    const pathC = 'C:/images/c.jpg';
    const pathD = 'C:/images/d.jpg';

    await getFullAsset(pathA);
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    await getFullAsset(pathB);
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    await getFullAsset(pathC);
    vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'));
    await getFullAsset(pathD);

    expect(convertFileSrcMock).toHaveBeenCalledTimes(4);

    trimImageAssetCache(new Set([pathC]), 2);

    await getFullAsset(pathC);
    await getFullAsset(pathD);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(4);

    await getFullAsset(pathA);
    await getFullAsset(pathB);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(6);
  });

  it('trimImageAssetCache can prune non-keep paths even when cache is under max size', async () => {
    const { getFullAsset, trimImageAssetCache } = await loadCacheModule();

    const keepPath = 'C:/images/keep.jpg';
    const stalePath = 'C:/images/stale.jpg';

    await getFullAsset(keepPath);
    await getFullAsset(stalePath);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(2);

    trimImageAssetCache(new Set([keepPath]), 12, { pruneMissing: true });

    await getFullAsset(keepPath);
    await getFullAsset(stalePath);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(3);
  });

  it('caches preview asset URLs and reuses them for repeated reads', async () => {
    const { getPreviewAsset } = await loadCacheModule();
    const path = 'C:/images/preview-a.jpg';

    const first = await getPreviewAsset(path);
    const second = await getPreviewAsset(path);

    expect(first).toBe(second);
    expect(first).toContain('asset://localhost/');
    expect(first).toContain('v=preview-2048-C%3A%2Fimages%2Fpreview-a.jpg-base');
    expect(getPreviewImageMock).toHaveBeenCalledTimes(1);
    expect(getPreviewImageMock).toHaveBeenCalledWith(path, 2048, undefined);
  });

  it('invalidateImageAsset clears stale preview cache for that path', async () => {
    const { getPreviewAsset, invalidateImageAsset } = await loadCacheModule();
    const path = 'C:/images/preview-invalidate.jpg';

    getPreviewImageMock
      .mockResolvedValueOnce({
        file_path: 'C:/cache/preview-before.jpg',
        cache_key: 'before-edit',
      })
      .mockResolvedValueOnce({
        file_path: 'C:/cache/preview-after.jpg',
        cache_key: 'after-edit-busted',
      });

    const first = await getPreviewAsset(path);
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    const invalidationVersion = Date.now();
    invalidateImageAsset(path);
    const second = await getPreviewAsset(path);

    expect(first).toContain('v=before-edit');
    expect(second).toContain('v=after-edit-busted');
    expect(second).not.toBe(first);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(2);
    expect(getPreviewImageMock).toHaveBeenLastCalledWith(path, 2048, invalidationVersion);
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

  it('does not persist full asset cache entry when stale preload guard expires', async () => {
    const { getFullAsset, preloadFullAsset } = await loadCacheModule();
    const path = 'C:/images/stale-preload-full.jpg';

    let guardCalls = 0;
    const pendingPreload = preloadFullAsset(path, {
      canStore: () => {
        guardCalls += 1;
        return guardCalls === 1;
      },
    });

    await pendingPreload;

    await getFullAsset(path);
    expect(convertFileSrcMock).toHaveBeenCalledTimes(2);
  });

  it('does not persist preview cache entry when stale preload guard expires', async () => {
    const { getPreviewAsset, preloadPreviewAsset } = await loadCacheModule();
    const path = 'C:/images/stale-preload-preview.jpg';

    let resolvePreview:
      | ((asset: { file_path: string; cache_key: string }) => void)
      | undefined;
    getPreviewImageMock.mockImplementationOnce(
      () =>
        new Promise<{ file_path: string; cache_key: string }>((resolve) => {
          resolvePreview = resolve;
        })
    );

    let isCurrentGeneration = true;
    const pendingPreload = preloadPreviewAsset(path, 2048, {
      canStore: () => isCurrentGeneration,
    });

    isCurrentGeneration = false;
    resolvePreview?.({
      file_path: 'C:/cache/stale-preload-preview.jpg',
      cache_key: `preview-2048-${path}`,
    });
    await pendingPreload;

    await getPreviewAsset(path);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(2);
  });
});

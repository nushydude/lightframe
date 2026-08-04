import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimatePreviewAssetBytes } from './cacheMemory';

const convertFileSrcMock = vi.fn((path: string) => `asset://localhost/${path}`);
const retainDecodedImageMock = vi.fn((url: string) => ({ url }) as unknown as HTMLImageElement);
const releaseRetainedDecodedImageMock = vi.fn();
type GeneratedImageAssetMock = {
  file_path: string;
  cache_key: string;
  width?: number;
  height?: number;
};

const defaultGetPreviewImageMock = async (
  path: string,
  maxDimension: number,
  invalidationBust?: number
): Promise<GeneratedImageAssetMock> => ({
  file_path: `C:/cache/preview-${maxDimension}-${path.replace(/[:/]/g, '_')}-${invalidationBust ?? 'base'}.jpg`,
  cache_key: `preview-${maxDimension}-${path}-${invalidationBust ?? 'base'}`,
});
const getPreviewImageMock = vi.fn(defaultGetPreviewImageMock);
const cancelMediaRequestMock = vi.fn().mockResolvedValue(false);
const releaseSessionAssetDeliveryMock = vi.fn().mockResolvedValue(true);

const getSessionAssetUrlMock = vi.fn(
  async (sessionId: string, imageId: string) => `asset://localhost/session/${sessionId}/${imageId}`
);

vi.mock('./tauriCommands', () => ({
  convertFileSrc: convertFileSrcMock,
  getSessionAssetUrl: getSessionAssetUrlMock,
  releaseSessionAssetDelivery: releaseSessionAssetDeliveryMock,
  generatedImageAssetToUrl: (asset: { file_path: string; cache_key: string }) =>
    `${convertFileSrcMock(asset.file_path)}?v=${encodeURIComponent(asset.cache_key)}`,
  getPreviewImage: getPreviewImageMock,
  getPreviewImageById: vi.fn(
    async (_sessionId: string, _imageId: string, maxDimension: number, invalidationBust?: number) =>
      defaultGetPreviewImageMock('authorized-image', maxDimension, invalidationBust)
  ),
  cancelMediaRequest: cancelMediaRequestMock,
}));

vi.mock('./retainedImage', () => ({
  retainDecodedImage: retainDecodedImageMock,
  releaseRetainedDecodedImage: releaseRetainedDecodedImageMock,
}));

async function loadCacheModule() {
  return import('./imageAssetCache');
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('imageAssetCache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getPreviewImageMock.mockReset();
    releaseSessionAssetDeliveryMock.mockReset().mockResolvedValue(true);
    getPreviewImageMock.mockImplementation(defaultGetPreviewImageMock);
    retainDecodedImageMock.mockImplementation(
      (url: string) => ({ url }) as unknown as HTMLImageElement
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the same URL for repeated reads before invalidation', async () => {
    const { requestFullAsset } = await loadCacheModule();
    const item = { path: 'C:/images/a.jpg', sessionId: 'sess-1', id: 'img-1' };

    const first = await requestFullAsset(item);
    const second = await requestFullAsset(item);

    expect(first).toBe(second);
  });

  it('never reuses same-path full-asset authority across sessions or image IDs', async () => {
    const { requestFullAsset } = await loadCacheModule();
    const path = 'C:/images/reopened.jpg';
    const [first, second] = await Promise.all([
      requestFullAsset({ path, sessionId: 'sess-old', id: 'img-old' }),
      requestFullAsset({ path, sessionId: 'sess-new', id: 'img-new' }),
    ]);

    expect(first).toContain('sess-old/img-old');
    expect(second).toContain('sess-new/img-new');
    expect(first).not.toBe(second);
    await expect(requestFullAsset({ path, sessionId: 'sess-old', id: 'img-old' })).resolves.toBe(
      first
    );
  });

  it('invalidateImageAsset changes only the invalidated path URL', async () => {
    const { requestFullAsset, invalidateImageAsset } = await loadCacheModule();

    const itemA = { path: 'C:/images/a.jpg', sessionId: 'sess-1', id: 'img-a' };
    const itemB = { path: 'C:/images/b.jpg', sessionId: 'sess-1', id: 'img-b' };

    const firstA = await requestFullAsset(itemA);
    const firstB = await requestFullAsset(itemB);

    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    invalidateImageAsset(itemA.path);

    const secondA = await requestFullAsset(itemA);
    const secondB = await requestFullAsset(itemB);

    expect(secondA).not.toBe(firstA);
    expect(secondA).toContain('v=');
    expect(secondB).toBe(firstB);
  });

  it('uses strictly increasing mutation generations while the wall clock is frozen', async () => {
    const { requestFullAsset, invalidateImageAsset } = await loadCacheModule();
    const item = { path: 'C:/images/frozen.jpg', sessionId: 'sess-1', id: 'img-frozen' };

    const first = await requestFullAsset(item);
    invalidateImageAsset(item.path);
    const second = await requestFullAsset(item);
    invalidateImageAsset(item.path);
    const third = await requestFullAsset(item);

    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('applies invalidation version when path is invalidated before first read', async () => {
    const { requestFullAsset, invalidateImageAsset } = await loadCacheModule();
    const item = { path: 'C:/images/new.jpg', sessionId: 'sess-1', id: 'img-new' };

    vi.setSystemTime(new Date('2026-01-01T00:00:09.000Z'));
    invalidateImageAsset(item.path);

    const url = await requestFullAsset(item);

    expect(url).toContain('v=1767225609000');
  });

  it('preserves invalidation version across trim eviction for future reads', async () => {
    const { requestFullAsset, invalidateImageAsset, trimImageAssetCache } = await loadCacheModule();
    const item = { path: 'C:/images/trim-race.jpg', sessionId: 'sess-1', id: 'img-trim' };

    await requestFullAsset(item);

    vi.setSystemTime(new Date('2026-01-01T00:00:12.000Z'));
    const invalidationVersion = Date.now();
    invalidateImageAsset(item.path);

    trimImageAssetCache(new Set(), 0);

    const urlAfterTrim = await requestFullAsset(item);
    expect(urlAfterTrim).toContain(`v=${invalidationVersion}`);
  });

  it('trimImageAssetCache keeps requested paths and evicts distant entries deterministically', async () => {
    const { requestFullAsset, trimImageAssetCache } = await loadCacheModule();

    const itemA = { path: 'C:/images/a.jpg', sessionId: 'sess-1', id: 'img-a' };
    const itemB = { path: 'C:/images/b.jpg', sessionId: 'sess-1', id: 'img-b' };
    const itemC = { path: 'C:/images/c.jpg', sessionId: 'sess-1', id: 'img-c' };
    const itemD = { path: 'C:/images/d.jpg', sessionId: 'sess-1', id: 'img-d' };

    await requestFullAsset(itemA);
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    await requestFullAsset(itemB);
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    await requestFullAsset(itemC);
    vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'));
    await requestFullAsset(itemD);

    trimImageAssetCache(new Set([itemC.path]), 2);

    const resC = await requestFullAsset(itemC);
    const resD = await requestFullAsset(itemD);

    const resA = await requestFullAsset(itemA);
    const resB = await requestFullAsset(itemB);

    expect(resC).toBeDefined();
    expect(resD).toBeDefined();
    expect(resA).toBeDefined();
    expect(resB).toBeDefined();
  });

  it('trimImageAssetCache can prune non-keep paths even when cache is under max size', async () => {
    const { requestFullAsset, trimImageAssetCache } = await loadCacheModule();

    const keepItem = { path: 'C:/images/keep.jpg', sessionId: 'sess-1', id: 'img-k' };
    const staleItem = { path: 'C:/images/stale.jpg', sessionId: 'sess-1', id: 'img-s' };

    await requestFullAsset(keepItem);
    await requestFullAsset(staleItem);

    trimImageAssetCache(new Set([keepItem.path]), 12, { pruneMissing: true });

    const keepRes = await requestFullAsset(keepItem);
    const staleRes = await requestFullAsset(staleItem);

    expect(keepRes).toBeDefined();
    expect(staleRes).toBeDefined();
  });

  it('trimImageAssetCache can prune against a wider folder scope than the visible keep set', async () => {
    const { requestFullAsset, trimImageAssetCache } = await loadCacheModule();

    const visibleItem = { path: 'C:/images/favorite.jpg', sessionId: 'sess-1', id: 'img-v' };
    const hiddenItem = { path: 'C:/images/not-favorite.jpg', sessionId: 'sess-1', id: 'img-h' };
    const staleItem = { path: 'C:/images/removed.jpg', sessionId: 'sess-1', id: 'img-r' };

    await requestFullAsset(visibleItem);
    await requestFullAsset(hiddenItem);
    await requestFullAsset(staleItem);

    trimImageAssetCache(new Set([visibleItem.path]), 12, {
      pruneMissing: true,
      pruneMissingPaths: new Set([visibleItem.path, hiddenItem.path]),
    });

    const visRes = await requestFullAsset(visibleItem);
    const hidRes = await requestFullAsset(hiddenItem);
    const staRes = await requestFullAsset(staleItem);

    expect(visRes).toBeDefined();
    expect(hidRes).toBeDefined();
    expect(staRes).toBeDefined();
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
    expect(getPreviewImageMock).toHaveBeenCalledWith(path, 2048, undefined, expect.any(String));
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
    expect(getPreviewImageMock).toHaveBeenLastCalledWith(
      path,
      2048,
      invalidationVersion,
      expect.any(String)
    );
  });

  it('never publishes a late preview from an older frozen-clock generation', async () => {
    const { getPreviewAsset, invalidateImageAsset } = await loadCacheModule();
    const path = 'C:/images/late-preview.jpg';
    const stale = createDeferred<{ file_path: string; cache_key: string }>();
    getPreviewImageMock
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({
        file_path: 'C:/cache/current.jpg',
        cache_key: 'current-generation',
      });

    const pending = getPreviewAsset(path);
    invalidateImageAsset(path);
    invalidateImageAsset(path);
    stale.resolve({ file_path: 'C:/cache/stale.jpg', cache_key: 'stale-generation' });

    await expect(pending).resolves.toContain('current-generation');
    await expect(getPreviewAsset(path)).resolves.toContain('current-generation');
    expect(getPreviewImageMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the current preview cached even when the byte budget is exhausted', async () => {
    const { configureImageAssetCache, getPreviewAsset } = await loadCacheModule();
    const path = 'C:/images/current-pressure.jpg';

    configureImageAssetCache({ previewCacheBudgetBytes: 0 });

    await getPreviewAsset(path);
    await getPreviewAsset(path);

    expect(getPreviewImageMock).toHaveBeenCalledTimes(1);
  });

  it('evicts least-recently-used preview assets under byte pressure while protecting keep paths', async () => {
    const { configureImageAssetCache, getPreviewAsset, trimImageAssetCache } =
      await loadCacheModule();
    const paths = Array.from({ length: 3 }, (_, i) => `C:/images/preview-${i}.jpg`);

    const firstUrl = await getPreviewAsset(paths[0]);
    const perEntryBytes = estimatePreviewAssetBytes({
      maxDimension: 2048,
      url: firstUrl,
    });
    configureImageAssetCache({ previewCacheBudgetBytes: perEntryBytes * 2 });

    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    await getPreviewAsset(paths[1]);
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    await getPreviewAsset(paths[2]);

    trimImageAssetCache(new Set([paths[1], paths[2]]), 12);

    await getPreviewAsset(paths[1]);
    await getPreviewAsset(paths[2]);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(3);

    await getPreviewAsset(paths[0]);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(4);
  });

  it('uses generated preview dimensions for byte-budget eviction', async () => {
    const { configureImageAssetCache, getPreviewAsset } = await loadCacheModule();
    const pathA = 'C:/images/small-preview-a.jpg';
    const pathB = 'C:/images/small-preview-b.jpg';

    getPreviewImageMock.mockImplementation(async (path: string, maxDimension: number) => ({
      file_path: `C:/cache/small-${path.replace(/[:/]/g, '_')}.jpg`,
      cache_key: `small-${maxDimension}-${path}`,
      width: 640,
      height: 360,
    }));

    const firstUrl = await getPreviewAsset(pathA);
    configureImageAssetCache({
      previewCacheBudgetBytes:
        estimatePreviewAssetBytes({
          maxDimension: 2048,
          url: firstUrl,
          width: 640,
          height: 360,
        }) *
          2 +
        4096,
    });

    await getPreviewAsset(pathB);
    await getPreviewAsset(pathA);

    expect(getPreviewImageMock).toHaveBeenCalledTimes(2);
  });

  it('demotes stale adjacent preview protections when the budget shrinks', async () => {
    const { configureImageAssetCache, getPreviewAsset, trimImageAssetCache } =
      await loadCacheModule();
    const paths = [
      'C:/images/current-preview.jpg',
      'C:/images/old-adjacent-a.jpg',
      'C:/images/old-adjacent-b.jpg',
    ];

    const currentUrl = await getPreviewAsset(paths[0]);
    await getPreviewAsset(paths[1]);
    await getPreviewAsset(paths[2]);

    trimImageAssetCache(new Set(paths), 12);
    configureImageAssetCache({
      previewCacheBudgetBytes: estimatePreviewAssetBytes({
        maxDimension: 2048,
        url: currentUrl,
      }),
    });

    await getPreviewAsset(paths[0]);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(3);

    await getPreviewAsset(paths[1]);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(4);
  });

  it('does not persist full asset cache entry when stale preload guard expires', async () => {
    const { requestFullAsset, preloadFullAsset } = await loadCacheModule();
    const item = { path: 'C:/images/stale-preload-full.jpg', sessionId: 'sess-1', id: 'img-stale' };

    let guardCalls = 0;
    const pendingPreload = preloadFullAsset(item, {
      canStore: () => {
        guardCalls += 1;
        return guardCalls === 1;
      },
    });

    await pendingPreload;

    const url = await requestFullAsset(item);
    expect(url).toBeDefined();
  });

  it('releases a delivery minted after the requesting consumer aborts', async () => {
    const deferred = createDeferred<string>();
    getSessionAssetUrlMock.mockReturnValueOnce(deferred.promise);
    const { requestFullAsset } = await loadCacheModule();
    const controller = new AbortController();
    const request = requestFullAsset(
      { path: 'C:/images/aborted-full.jpg', sessionId: 'sess-1', id: 'img-abort' },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(getSessionAssetUrlMock).toHaveBeenCalledOnce());

    controller.abort();
    deferred.resolve('lightframe-asset://sess-1/img-abort?deliveryId=delivery_abort');

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(releaseSessionAssetDeliveryMock).toHaveBeenCalledWith(
      'lightframe-asset://sess-1/img-abort?deliveryId=delivery_abort'
    );
  });

  it('releases a minted delivery discarded by a concurrent mutation', async () => {
    const deferred = createDeferred<string>();
    getSessionAssetUrlMock.mockReturnValueOnce(deferred.promise);
    const { invalidateImageAsset, requestFullAsset } = await loadCacheModule();
    const path = 'C:/images/superseded-full.jpg';
    const request = requestFullAsset({ path, sessionId: 'sess-1', id: 'img-stale' });
    await vi.waitFor(() => expect(getSessionAssetUrlMock).toHaveBeenCalledOnce());

    invalidateImageAsset(path);
    deferred.resolve('lightframe-asset://sess-1/img-stale?deliveryId=delivery_stale');

    await expect(request).rejects.toThrow('superseded');
    expect(releaseSessionAssetDeliveryMock).toHaveBeenCalledWith(
      'lightframe-asset://sess-1/img-stale?deliveryId=delivery_stale'
    );
  });

  it('does not release another caller delivery when serving a cache hit', async () => {
    let delivery = 0;
    getSessionAssetUrlMock.mockImplementation(async () => {
      delivery += 1;
      return `lightframe-asset://sess-1/img-1?deliveryId=delivery_${delivery}`;
    });
    const { requestFullAsset } = await loadCacheModule();
    const item = { path: 'C:/images/replaced-full.jpg', sessionId: 'sess-1', id: 'img-1' };

    const first = await requestFullAsset(item);
    const second = await requestFullAsset(item);

    expect(second).not.toBe(first);
    expect(releaseSessionAssetDeliveryMock).not.toHaveBeenCalledWith(first);
  });

  it('keeps concurrent cache-hit deliveries independently owned', async () => {
    let delivery = 0;
    getSessionAssetUrlMock.mockImplementation(async () => {
      delivery += 1;
      return `lightframe-asset://sess-1/img-1?deliveryId=delivery_${delivery}`;
    });
    const { requestFullAsset } = await loadCacheModule();
    const item = { path: 'C:/images/concurrent-full.jpg', sessionId: 'sess-1', id: 'img-1' };

    const initial = await requestFullAsset(item);
    const [firstHit, secondHit] = await Promise.all([
      requestFullAsset(item),
      requestFullAsset(item),
    ]);

    expect(new Set([initial, firstHit, secondHit]).size).toBe(3);
    expect(releaseSessionAssetDeliveryMock).not.toHaveBeenCalledWith(initial);
    expect(releaseSessionAssetDeliveryMock).not.toHaveBeenCalledWith(firstHit);
    expect(releaseSessionAssetDeliveryMock).not.toHaveBeenCalledWith(secondHit);
  });

  it('mints distinct cold-miss deliveries and aborting one does not release the other', async () => {
    const firstDelivery = createDeferred<string>();
    const secondDelivery = createDeferred<string>();
    getSessionAssetUrlMock
      .mockReturnValueOnce(firstDelivery.promise)
      .mockReturnValueOnce(secondDelivery.promise);
    const { requestFullAsset } = await loadCacheModule();
    const item = { path: 'C:/images/cold-concurrent.jpg', sessionId: 'sess-1', id: 'img-1' };
    const firstController = new AbortController();

    const first = requestFullAsset(item, { signal: firstController.signal });
    const second = requestFullAsset(item);
    await vi.waitFor(() => expect(getSessionAssetUrlMock).toHaveBeenCalledTimes(2));
    firstController.abort();
    firstDelivery.resolve('lightframe-asset://sess-1/img-1?deliveryId=cold_1');
    secondDelivery.resolve('lightframe-asset://sess-1/img-1?deliveryId=cold_2');

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toContain('deliveryId=cold_2');
    expect(releaseSessionAssetDeliveryMock).toHaveBeenCalledWith(
      'lightframe-asset://sess-1/img-1?deliveryId=cold_1'
    );
    expect(releaseSessionAssetDeliveryMock).not.toHaveBeenCalledWith(
      'lightframe-asset://sess-1/img-1?deliveryId=cold_2'
    );
  });

  it('releases every cold and cached preload delivery without touching an interactive delivery', async () => {
    let delivery = 0;
    getSessionAssetUrlMock.mockImplementation(async () => {
      delivery += 1;
      return `lightframe-asset://sess-1/img-preload?deliveryId=preload_${delivery}`;
    });
    const { preloadFullAsset, requestFullAsset } = await loadCacheModule();
    const item = {
      path: 'C:/images/repeated-preload.jpg',
      sessionId: 'sess-1',
      id: 'img-preload',
    };

    await preloadFullAsset(item);
    await preloadFullAsset(item);
    await preloadFullAsset(item);
    const interactive = await requestFullAsset(item);

    expect(releaseSessionAssetDeliveryMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining('deliveryId=preload_1'),
      expect.stringContaining('deliveryId=preload_2'),
      expect.stringContaining('deliveryId=preload_3'),
    ]);
    expect(interactive).toContain('deliveryId=preload_4');
    expect(releaseSessionAssetDeliveryMock).not.toHaveBeenCalledWith(interactive);
  });

  it('does not persist preview cache entry when stale preload guard expires', async () => {
    const { getPreviewAsset, preloadPreviewAsset } = await loadCacheModule();
    const path = 'C:/images/stale-preload-preview.jpg';

    let resolvePreview: ((asset: { file_path: string; cache_key: string }) => void) | undefined;
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

    expect(retainDecodedImageMock).not.toHaveBeenCalled();

    await getPreviewAsset(path);
    expect(getPreviewImageMock).toHaveBeenCalledTimes(2);
    expect(retainDecodedImageMock).toHaveBeenCalledTimes(1);
  });

  it('does not create a throwaway image for preview preloads', async () => {
    const originalImage = globalThis.Image;
    const imageConstructor = vi.fn();
    globalThis.Image = imageConstructor as unknown as typeof Image;

    try {
      const { preloadPreviewAsset } = await loadCacheModule();
      await preloadPreviewAsset('C:/images/preload-retained-only.jpg');

      expect(retainDecodedImageMock).toHaveBeenCalledTimes(1);
      expect(imageConstructor).not.toHaveBeenCalled();
    } finally {
      globalThis.Image = originalImage;
    }
  });

  it('cancels queued preview preload work before preview generation starts', async () => {
    const { preloadPreviewAsset } = await loadCacheModule();

    const firstDeferred = createDeferred<{ file_path: string; cache_key: string }>();
    getPreviewImageMock
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(async () => ({
        file_path: 'C:/cache/should-not-run.jpg',
        cache_key: 'should-not-run',
      }));

    const staleAbortController = new AbortController();

    const firstPromise = preloadPreviewAsset('C:/images/active.jpg');
    const stalePromise = preloadPreviewAsset('C:/images/stale.jpg', 2048, {
      signal: staleAbortController.signal,
    });

    expect(getPreviewImageMock).toHaveBeenCalledTimes(1);

    staleAbortController.abort();
    firstDeferred.resolve({
      file_path: 'C:/cache/active.jpg',
      cache_key: 'active',
    });

    await firstPromise;
    await expect(stalePromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(getPreviewImageMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a coalesced backend preview only after its final consumer aborts', async () => {
    const { getPreviewAsset } = await loadCacheModule();
    const deferred = createDeferred<{ file_path: string; cache_key: string }>();
    getPreviewImageMock.mockImplementationOnce(() => deferred.promise);
    const first = new AbortController();
    const second = new AbortController();

    const firstRead = getPreviewAsset('C:/images/shared.jpg', 2048, { signal: first.signal });
    const secondRead = getPreviewAsset('C:/images/shared.jpg', 2048, { signal: second.signal });
    expect(getPreviewImageMock).toHaveBeenCalledTimes(1);

    first.abort();
    await expect(firstRead).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelMediaRequestMock).not.toHaveBeenCalled();

    deferred.resolve({ file_path: 'C:/cache/shared.jpg', cache_key: 'shared' });
    await expect(secondRead).resolves.toContain('shared.jpg');
    expect(cancelMediaRequestMock).not.toHaveBeenCalled();
  });

  it('cancels a coalesced backend preview exactly once when the last consumer aborts', async () => {
    const { getPreviewAsset } = await loadCacheModule();
    const deferred = createDeferred<{ file_path: string; cache_key: string }>();
    getPreviewImageMock.mockImplementationOnce(() => deferred.promise);
    const first = new AbortController();
    const second = new AbortController();

    const firstRead = getPreviewAsset('C:/images/all-cancel.jpg', 2048, { signal: first.signal });
    const secondRead = getPreviewAsset('C:/images/all-cancel.jpg', 2048, {
      signal: second.signal,
    });
    second.abort();
    await expect(secondRead).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelMediaRequestMock).not.toHaveBeenCalled();

    first.abort();
    await expect(firstRead).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelMediaRequestMock).toHaveBeenCalledTimes(1);

    deferred.resolve({ file_path: 'C:/cache/all-cancel.jpg', cache_key: 'all-cancel' });
  });

  it('bounds mutation-version history after many invalidations', async () => {
    const { invalidateImageAsset, getImageAssetCacheVersionEntryCountForTests } =
      await loadCacheModule();

    for (let index = 0; index < 2500; index += 1) {
      invalidateImageAsset(`C:/images/folder-${index}/image.jpg`);
    }

    expect(getImageAssetCacheVersionEntryCountForTests()).toBeLessThanOrEqual(2048);
  });

  it('preserves a mutation generation after its exact path entry is pruned', async () => {
    const { invalidateImageAsset, requestFullAsset } = await loadCacheModule();
    const image = {
      path: 'C:/images/pruned-first/image.jpg',
      sessionId: 'sess-pruned',
      id: 'img-pruned',
    };
    invalidateImageAsset(image.path);
    for (let index = 0; index < 2500; index += 1) {
      invalidateImageAsset(`C:/images/prune-pressure-${index}/image.jpg`);
    }

    const url = await requestFullAsset(image);
    expect(url).toContain('v=');
    expect(url).not.toContain('v=0');
  });
});

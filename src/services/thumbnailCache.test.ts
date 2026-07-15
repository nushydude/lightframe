import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateThumbnailAssetBytes } from './cacheMemory';

const getThumbnailMock = vi.fn<
  (
    path: string,
    sizeBytes?: number,
    modifiedAt?: string
  ) => Promise<{
    file_path: string;
    cache_key: string;
  }>
>();

vi.mock('./tauriCommands', () => ({
  generatedImageAssetToUrl: (asset: { file_path: string; cache_key: string }) =>
    `asset://localhost/${asset.file_path}?v=${encodeURIComponent(asset.cache_key)}`,
  getThumbnail: getThumbnailMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadThumbnailCacheModule() {
  return import('./thumbnailCache');
}

describe('thumbnailCache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns cached thumbnails without re-requesting from Tauri', async () => {
    const { clearThumbnailCacheForTests, getCachedThumbnail, loadThumbnail } =
      await loadThumbnailCacheModule();

    getThumbnailMock.mockResolvedValueOnce({
      file_path: 'C:/cache/a.jpg',
      cache_key: 'AAA',
    });

    const first = await loadThumbnail('C:/images/a.jpg');
    const cached = getCachedThumbnail('C:/images/a.jpg');
    const second = await loadThumbnail('C:/images/a.jpg');

    expect(first).toBe('asset://localhost/C:/cache/a.jpg?v=AAA');
    expect(cached).toBe('asset://localhost/C:/cache/a.jpg?v=AAA');
    expect(second).toBe('asset://localhost/C:/cache/a.jpg?v=AAA');
    expect(getThumbnailMock).toHaveBeenCalledTimes(1);

    clearThumbnailCacheForTests();
  });

  it('treats known fallback assets as cacheable thumbnail results', async () => {
    const { clearThumbnailCacheForTests, getCachedThumbnail, loadThumbnail } =
      await loadThumbnailCacheModule();

    const request = { path: 'C:/images/unsupported.heic', sizeBytes: 128, modifiedAt: '42' };
    getThumbnailMock.mockResolvedValueOnce({
      file_path: 'C:/cache/fallback.svg',
      cache_key: 'FALLBACK',
    });

    const first = await loadThumbnail(request);
    const cached = getCachedThumbnail(request);
    const second = await loadThumbnail(request);

    expect(first).toBe('asset://localhost/C:/cache/fallback.svg?v=FALLBACK');
    expect(cached).toBe('asset://localhost/C:/cache/fallback.svg?v=FALLBACK');
    expect(second).toBe('asset://localhost/C:/cache/fallback.svg?v=FALLBACK');
    expect(getThumbnailMock).toHaveBeenCalledTimes(1);
    expect(getThumbnailMock).toHaveBeenCalledWith('C:/images/unsupported.heic', 128, '42');

    clearThumbnailCacheForTests();
  });

  it('reuses cached thumbnails for identical structured requests', async () => {
    const { clearThumbnailCacheForTests, loadThumbnail } = await loadThumbnailCacheModule();
    getThumbnailMock.mockResolvedValueOnce({
      file_path: 'C:/cache/structured.jpg',
      cache_key: 'STRUCTURED',
    });

    const request = { path: 'C:/images/structured.jpg', sizeBytes: 300, modifiedAt: '10' };
    const first = await loadThumbnail(request);
    const second = await loadThumbnail(request);

    expect(first).toBe('asset://localhost/C:/cache/structured.jpg?v=STRUCTURED');
    expect(second).toBe('asset://localhost/C:/cache/structured.jpg?v=STRUCTURED');
    expect(getThumbnailMock).toHaveBeenCalledTimes(1);
    expect(getThumbnailMock).toHaveBeenCalledWith('C:/images/structured.jpg', 300, '10');

    clearThumbnailCacheForTests();
  });

  it('drops stale path entries when metadata changes for the same image path', async () => {
    const { clearThumbnailCacheForTests, getCachedThumbnail, loadThumbnail } =
      await loadThumbnailCacheModule();

    getThumbnailMock
      .mockResolvedValueOnce({ file_path: 'C:/cache/old.jpg', cache_key: 'OLD' })
      .mockResolvedValueOnce({ file_path: 'C:/cache/new.jpg', cache_key: 'NEW' });

    await loadThumbnail({ path: 'C:/images/a.jpg', sizeBytes: 100, modifiedAt: '1' });

    expect(getCachedThumbnail({ path: 'C:/images/a.jpg', sizeBytes: 100, modifiedAt: '1' })).toBe(
      'asset://localhost/C:/cache/old.jpg?v=OLD'
    );

    expect(
      getCachedThumbnail({ path: 'C:/images/a.jpg', sizeBytes: 100, modifiedAt: '2' })
    ).toBeUndefined();

    const refreshed = await loadThumbnail({
      path: 'C:/images/a.jpg',
      sizeBytes: 100,
      modifiedAt: '2',
    });

    expect(refreshed).toBe('asset://localhost/C:/cache/new.jpg?v=NEW');
    expect(getThumbnailMock).toHaveBeenNthCalledWith(1, 'C:/images/a.jpg', 100, '1');
    expect(getThumbnailMock).toHaveBeenNthCalledWith(2, 'C:/images/a.jpg', 100, '2');

    clearThumbnailCacheForTests();
  });

  it('distinguishes sub-second metadata tokens for same-size images', async () => {
    const { clearThumbnailCacheForTests, getCachedThumbnail, loadThumbnail } =
      await loadThumbnailCacheModule();
    const firstRequest = {
      path: 'C:/images/rapid-edit.jpg',
      sizeBytes: 100,
      modifiedAt: '1700000000123456789',
    };
    const secondRequest = {
      ...firstRequest,
      modifiedAt: '1700000000123456790',
    };

    getThumbnailMock
      .mockResolvedValueOnce({ file_path: 'C:/cache/old.jpg', cache_key: 'OLD' })
      .mockResolvedValueOnce({ file_path: 'C:/cache/new.jpg', cache_key: 'NEW' });

    await loadThumbnail(firstRequest);
    expect(getCachedThumbnail(secondRequest)).toBeUndefined();
    await loadThumbnail(secondRequest);

    expect(getThumbnailMock).toHaveBeenNthCalledWith(
      2,
      secondRequest.path,
      secondRequest.sizeBytes,
      secondRequest.modifiedAt
    );
    clearThumbnailCacheForTests();
  });

  it('ignores stale in-flight completions when metadata changes mid-flight', async () => {
    const { clearThumbnailCacheForTests, getCachedThumbnail, loadThumbnail } =
      await loadThumbnailCacheModule();
    const deferredA = createDeferred<{ file_path: string; cache_key: string }>();
    const deferredB = createDeferred<{ file_path: string; cache_key: string }>();

    getThumbnailMock
      .mockImplementationOnce(() => deferredA.promise)
      .mockImplementationOnce(() => deferredB.promise);

    const requestA = { path: 'C:/images/race.jpg', sizeBytes: 100, modifiedAt: '1' };
    const requestB = { path: 'C:/images/race.jpg', sizeBytes: 100, modifiedAt: '2' };

    const promiseA = loadThumbnail(requestA);
    const promiseB = loadThumbnail(requestB);

    expect(promiseA).not.toBe(promiseB);
    expect(getThumbnailMock).toHaveBeenCalledTimes(2);

    deferredA.resolve({ file_path: 'C:/cache/old.jpg', cache_key: 'OLD' });
    await expect(promiseA).resolves.toBe('asset://localhost/C:/cache/old.jpg?v=OLD');
    expect(getCachedThumbnail(requestB)).toBeUndefined();

    deferredB.resolve({ file_path: 'C:/cache/new.jpg', cache_key: 'NEW' });
    await expect(promiseB).resolves.toBe('asset://localhost/C:/cache/new.jpg?v=NEW');
    expect(getCachedThumbnail(requestB)).toBe('asset://localhost/C:/cache/new.jpg?v=NEW');

    clearThumbnailCacheForTests();
  });

  it('deduplicates in-flight thumbnail requests for the same path', async () => {
    const { clearThumbnailCacheForTests, loadThumbnail } = await loadThumbnailCacheModule();
    const deferred = createDeferred<{ file_path: string; cache_key: string }>();
    getThumbnailMock.mockImplementationOnce(() => deferred.promise);

    const firstPromise = loadThumbnail('C:/images/in-flight.jpg');
    const secondPromise = loadThumbnail('C:/images/in-flight.jpg');

    expect(firstPromise).toBe(secondPromise);
    expect(getThumbnailMock).toHaveBeenCalledTimes(1);

    deferred.resolve({ file_path: 'C:/cache/inflight.jpg', cache_key: 'INFLIGHT' });
    await expect(firstPromise).resolves.toBe('asset://localhost/C:/cache/inflight.jpg?v=INFLIGHT');
    await expect(secondPromise).resolves.toBe('asset://localhost/C:/cache/inflight.jpg?v=INFLIGHT');

    clearThumbnailCacheForTests();
  });

  it('keeps visible thumbnails cached even when the byte budget is exhausted', async () => {
    const {
      clearThumbnailCacheForTests,
      configureThumbnailCache,
      evictThumbnailsExcept,
      loadThumbnail,
    } = await loadThumbnailCacheModule();

    getThumbnailMock.mockResolvedValueOnce({
      file_path: 'C:/cache/current.jpg',
      cache_key: 'CURRENT',
    });

    evictThumbnailsExcept(new Set(['C:/images/current.jpg']));
    configureThumbnailCache({ cacheBudgetBytes: 0 });

    await loadThumbnail('C:/images/current.jpg');
    await loadThumbnail('C:/images/current.jpg');

    expect(getThumbnailMock).toHaveBeenCalledTimes(1);

    clearThumbnailCacheForTests();
  });

  it('evicts least-recently-used thumbnails deterministically while keeping pinned paths', async () => {
    const {
      clearThumbnailCacheForTests,
      configureThumbnailCache,
      evictThumbnailsExcept,
      getCachedThumbnail,
      loadThumbnail,
    } = await loadThumbnailCacheModule();

    getThumbnailMock
      .mockResolvedValueOnce({ file_path: 'C:/cache/a.jpg', cache_key: 'A' })
      .mockResolvedValueOnce({ file_path: 'C:/cache/b.jpg', cache_key: 'B' })
      .mockResolvedValueOnce({ file_path: 'C:/cache/c.jpg', cache_key: 'C' });

    await loadThumbnail('C:/images/a.jpg');
    await loadThumbnail('C:/images/b.jpg');
    await loadThumbnail('C:/images/c.jpg');

    // Refresh A so B becomes the oldest evictable entry.
    expect(getCachedThumbnail('C:/images/a.jpg')).toBe('asset://localhost/C:/cache/a.jpg?v=A');

    evictThumbnailsExcept(new Set(['C:/images/a.jpg']));
    configureThumbnailCache({
      cacheBudgetBytes:
        estimateThumbnailAssetBytes({
          url: 'asset://localhost/C:/cache/a.jpg?v=A',
        }) * 2,
    });

    expect(getCachedThumbnail('C:/images/a.jpg')).toBe('asset://localhost/C:/cache/a.jpg?v=A');
    expect(getCachedThumbnail('C:/images/b.jpg')).toBeUndefined();
    expect(getCachedThumbnail('C:/images/c.jpg')).toBe('asset://localhost/C:/cache/c.jpg?v=C');

    clearThumbnailCacheForTests();
  });

  it('notifies preload listeners once and skips inactive callbacks', async () => {
    const { clearThumbnailCacheForTests, loadThumbnail, preloadThumbnails } =
      await loadThumbnailCacheModule();

    const deferredByPath = new Map<
      string,
      ReturnType<typeof createDeferred<{ file_path: string; cache_key: string }>>
    >();
    getThumbnailMock.mockImplementation((path: string) => {
      let deferred = deferredByPath.get(path);
      if (!deferred) {
        deferred = createDeferred<{ file_path: string; cache_key: string }>();
        deferredByPath.set(path, deferred);
      }
      return deferred.promise;
    });

    const onLoaded = vi.fn();
    preloadThumbnails(['C:/images/visible.jpg'], {
      onLoaded,
      concurrency: 4,
      isActive: () => true,
    });
    preloadThumbnails(['C:/images/visible.jpg'], {
      onLoaded,
      concurrency: 4,
      isActive: () => true,
    });

    const visiblePromise = loadThumbnail('C:/images/visible.jpg');
    deferredByPath
      .get('C:/images/visible.jpg')
      ?.resolve({ file_path: 'C:/cache/visible.jpg', cache_key: 'VISIBLE' });
    await visiblePromise;

    expect(getThumbnailMock).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith('C:/images/visible.jpg');

    const onUnmountedLoaded = vi.fn();
    let isMounted = true;
    preloadThumbnails(['C:/images/unmounted.jpg'], {
      onLoaded: onUnmountedLoaded,
      concurrency: 6,
      isActive: () => isMounted,
    });

    const unmountedPromise = loadThumbnail('C:/images/unmounted.jpg');
    isMounted = false;
    deferredByPath
      .get('C:/images/unmounted.jpg')
      ?.resolve({ file_path: 'C:/cache/unmounted.jpg', cache_key: 'UNMOUNTED' });
    await unmountedPromise;

    expect(onUnmountedLoaded).not.toHaveBeenCalled();

    clearThumbnailCacheForTests();
  });

  it('caps cache after in-flight over-cap queue settles and keeps latest keep-set paths', async () => {
    const {
      clearThumbnailCacheForTests,
      configureThumbnailCache,
      evictThumbnailsExcept,
      getCachedThumbnail,
      loadThumbnail,
      preloadThumbnails,
    } = await loadThumbnailCacheModule();

    const deferredByPath = new Map<
      string,
      ReturnType<typeof createDeferred<{ file_path: string; cache_key: string }>>
    >();
    getThumbnailMock.mockImplementation((path: string) => {
      let deferred = deferredByPath.get(path);
      if (!deferred) {
        deferred = createDeferred<{ file_path: string; cache_key: string }>();
        deferredByPath.set(path, deferred);
      }
      return deferred.promise;
    });

    const droppedListener = vi.fn();
    const keptListener = vi.fn();
    const paths = ['C:/images/a.jpg', 'C:/images/b.jpg', 'C:/images/c.jpg', 'C:/images/d.jpg'];

    preloadThumbnails(paths, { concurrency: 4 });
    preloadThumbnails(['C:/images/b.jpg'], {
      onLoaded: droppedListener,
      concurrency: 4,
      isActive: () => true,
    });
    preloadThumbnails(['C:/images/c.jpg'], {
      onLoaded: keptListener,
      concurrency: 4,
      isActive: () => true,
    });

    evictThumbnailsExcept(new Set(['C:/images/c.jpg']));
    configureThumbnailCache({
      cacheBudgetBytes:
        estimateThumbnailAssetBytes({
          url: 'asset://localhost/C:/cache/a.jpg?v=A',
        }) * 2,
    });

    deferredByPath.get('C:/images/a.jpg')?.resolve({ file_path: 'C:/cache/a.jpg', cache_key: 'A' });
    deferredByPath.get('C:/images/b.jpg')?.resolve({ file_path: 'C:/cache/b.jpg', cache_key: 'B' });
    deferredByPath.get('C:/images/c.jpg')?.resolve({ file_path: 'C:/cache/c.jpg', cache_key: 'C' });
    deferredByPath.get('C:/images/d.jpg')?.resolve({ file_path: 'C:/cache/d.jpg', cache_key: 'D' });

    await Promise.all(paths.map((path) => loadThumbnail(path).catch(() => undefined)));

    expect(getCachedThumbnail('C:/images/a.jpg')).toBeUndefined();
    expect(getCachedThumbnail('C:/images/b.jpg')).toBe('asset://localhost/C:/cache/b.jpg?v=B');
    expect(getCachedThumbnail('C:/images/c.jpg')).toBe('asset://localhost/C:/cache/c.jpg?v=C');
    expect(getCachedThumbnail('C:/images/d.jpg')).toBeUndefined();
    expect(droppedListener).not.toHaveBeenCalled();
    expect(keptListener).toHaveBeenCalledTimes(1);

    clearThumbnailCacheForTests();
  });

  it('cancels queued stale thumbnails before invoking Tauri thumbnail generation', async () => {
    const { clearThumbnailCacheForTests, evictThumbnailsExcept, loadThumbnail } =
      await loadThumbnailCacheModule();

    const deferredByPath = new Map<
      string,
      ReturnType<typeof createDeferred<{ file_path: string; cache_key: string }>>
    >();
    getThumbnailMock.mockImplementation((path: string) => {
      let deferred = deferredByPath.get(path);
      if (!deferred) {
        deferred = createDeferred<{ file_path: string; cache_key: string }>();
        deferredByPath.set(path, deferred);
      }
      return deferred.promise;
    });

    const activePaths = ['C:/images/a.jpg', 'C:/images/b.jpg', 'C:/images/c.jpg'];
    const stalePath = 'C:/images/stale.jpg';

    const activePromises = activePaths.map((path) => loadThumbnail(path));
    const stalePromise = loadThumbnail(stalePath);

    expect(getThumbnailMock).toHaveBeenCalledTimes(3);
    expect(getThumbnailMock).not.toHaveBeenCalledWith(stalePath, undefined, undefined);

    evictThumbnailsExcept(new Set(activePaths));

    await expect(stalePromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(getThumbnailMock).toHaveBeenCalledTimes(3);

    activePaths.forEach((path, index) => {
      deferredByPath
        .get(path)
        ?.resolve({ file_path: `C:/cache/${index}.jpg`, cache_key: String(index) });
    });

    await Promise.all(activePromises);

    clearThumbnailCacheForTests();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getThumbnailMock = vi.fn<
  (path: string, sizeBytes?: number, modifiedAt?: string) => Promise<string>
>();

vi.mock('./tauriCommands', () => ({
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

    getThumbnailMock.mockResolvedValueOnce('data:image/jpeg;base64,AAA');

    const first = await loadThumbnail('C:/images/a.jpg');
    const cached = getCachedThumbnail('C:/images/a.jpg');
    const second = await loadThumbnail('C:/images/a.jpg');

    expect(first).toBe('data:image/jpeg;base64,AAA');
    expect(cached).toBe('data:image/jpeg;base64,AAA');
    expect(second).toBe('data:image/jpeg;base64,AAA');
    expect(getThumbnailMock).toHaveBeenCalledTimes(1);

    clearThumbnailCacheForTests();
  });

  it('reuses cached thumbnails for identical structured requests', async () => {
    const { clearThumbnailCacheForTests, loadThumbnail } = await loadThumbnailCacheModule();
    getThumbnailMock.mockResolvedValueOnce('data:image/jpeg;base64,STRUCTURED');

    const request = { path: 'C:/images/structured.jpg', sizeBytes: 300, modifiedAt: '10' };
    const first = await loadThumbnail(request);
    const second = await loadThumbnail(request);

    expect(first).toBe('data:image/jpeg;base64,STRUCTURED');
    expect(second).toBe('data:image/jpeg;base64,STRUCTURED');
    expect(getThumbnailMock).toHaveBeenCalledTimes(1);
    expect(getThumbnailMock).toHaveBeenCalledWith('C:/images/structured.jpg', 300, '10');

    clearThumbnailCacheForTests();
  });

  it('drops stale path entries when metadata changes for the same image path', async () => {
    const { clearThumbnailCacheForTests, getCachedThumbnail, loadThumbnail } =
      await loadThumbnailCacheModule();

    getThumbnailMock
      .mockResolvedValueOnce('data:image/jpeg;base64,OLD')
      .mockResolvedValueOnce('data:image/jpeg;base64,NEW');

    await loadThumbnail({ path: 'C:/images/a.jpg', sizeBytes: 100, modifiedAt: '1' });

    expect(
      getCachedThumbnail({ path: 'C:/images/a.jpg', sizeBytes: 100, modifiedAt: '1' })
    ).toBe('data:image/jpeg;base64,OLD');

    expect(
      getCachedThumbnail({ path: 'C:/images/a.jpg', sizeBytes: 100, modifiedAt: '2' })
    ).toBeUndefined();

    const refreshed = await loadThumbnail({
      path: 'C:/images/a.jpg',
      sizeBytes: 100,
      modifiedAt: '2',
    });

    expect(refreshed).toBe('data:image/jpeg;base64,NEW');
    expect(getThumbnailMock).toHaveBeenNthCalledWith(1, 'C:/images/a.jpg', 100, '1');
    expect(getThumbnailMock).toHaveBeenNthCalledWith(2, 'C:/images/a.jpg', 100, '2');

    clearThumbnailCacheForTests();
  });

  it('ignores stale in-flight completions when metadata changes mid-flight', async () => {
    const { clearThumbnailCacheForTests, getCachedThumbnail, loadThumbnail } =
      await loadThumbnailCacheModule();
    const deferredA = createDeferred<string>();
    const deferredB = createDeferred<string>();

    getThumbnailMock
      .mockImplementationOnce(() => deferredA.promise)
      .mockImplementationOnce(() => deferredB.promise);

    const requestA = { path: 'C:/images/race.jpg', sizeBytes: 100, modifiedAt: '1' };
    const requestB = { path: 'C:/images/race.jpg', sizeBytes: 100, modifiedAt: '2' };

    const promiseA = loadThumbnail(requestA);
    const promiseB = loadThumbnail(requestB);

    expect(promiseA).not.toBe(promiseB);
    expect(getThumbnailMock).toHaveBeenCalledTimes(2);

    deferredA.resolve('data:image/jpeg;base64,OLD');
    await expect(promiseA).resolves.toBe('data:image/jpeg;base64,OLD');
    expect(getCachedThumbnail(requestB)).toBeUndefined();

    deferredB.resolve('data:image/jpeg;base64,NEW');
    await expect(promiseB).resolves.toBe('data:image/jpeg;base64,NEW');
    expect(getCachedThumbnail(requestB)).toBe('data:image/jpeg;base64,NEW');

    clearThumbnailCacheForTests();
  });

  it('deduplicates in-flight thumbnail requests for the same path', async () => {
    const { clearThumbnailCacheForTests, loadThumbnail } = await loadThumbnailCacheModule();
    const deferred = createDeferred<string>();
    getThumbnailMock.mockImplementationOnce(() => deferred.promise);

    const firstPromise = loadThumbnail('C:/images/in-flight.jpg');
    const secondPromise = loadThumbnail('C:/images/in-flight.jpg');

    expect(firstPromise).toBe(secondPromise);
    expect(getThumbnailMock).toHaveBeenCalledTimes(1);

    deferred.resolve('data:image/jpeg;base64,INFLIGHT');
    await expect(firstPromise).resolves.toBe('data:image/jpeg;base64,INFLIGHT');
    await expect(secondPromise).resolves.toBe('data:image/jpeg;base64,INFLIGHT');

    clearThumbnailCacheForTests();
  });

  it('evicts least-recently-used thumbnails deterministically while keeping pinned paths', async () => {
    const {
      clearThumbnailCacheForTests,
      evictThumbnailsExcept,
      getCachedThumbnail,
      loadThumbnail,
    } = await loadThumbnailCacheModule();

    getThumbnailMock
      .mockResolvedValueOnce('data:image/jpeg;base64,A')
      .mockResolvedValueOnce('data:image/jpeg;base64,B')
      .mockResolvedValueOnce('data:image/jpeg;base64,C');

    await loadThumbnail('C:/images/a.jpg');
    await loadThumbnail('C:/images/b.jpg');
    await loadThumbnail('C:/images/c.jpg');

    // Refresh A so B becomes the oldest evictable entry.
    expect(getCachedThumbnail('C:/images/a.jpg')).toBe('data:image/jpeg;base64,A');

    evictThumbnailsExcept(new Set(['C:/images/a.jpg']), 2);

    expect(getCachedThumbnail('C:/images/a.jpg')).toBe('data:image/jpeg;base64,A');
    expect(getCachedThumbnail('C:/images/b.jpg')).toBeUndefined();
    expect(getCachedThumbnail('C:/images/c.jpg')).toBe('data:image/jpeg;base64,C');

    clearThumbnailCacheForTests();
  });

  it('notifies preload listeners once and skips inactive callbacks', async () => {
    const { clearThumbnailCacheForTests, loadThumbnail, preloadThumbnails } =
      await loadThumbnailCacheModule();

    const deferredByPath = new Map<string, ReturnType<typeof createDeferred<string>>>();
    getThumbnailMock.mockImplementation((path: string) => {
      let deferred = deferredByPath.get(path);
      if (!deferred) {
        deferred = createDeferred<string>();
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
    deferredByPath.get('C:/images/visible.jpg')?.resolve('data:image/jpeg;base64,VISIBLE');
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
    deferredByPath.get('C:/images/unmounted.jpg')?.resolve('data:image/jpeg;base64,UNMOUNTED');
    await unmountedPromise;

    expect(onUnmountedLoaded).not.toHaveBeenCalled();

    clearThumbnailCacheForTests();
  });

  it('caps cache after in-flight over-cap queue settles and keeps latest keep-set paths', async () => {
    const {
      clearThumbnailCacheForTests,
      evictThumbnailsExcept,
      getCachedThumbnail,
      loadThumbnail,
      preloadThumbnails,
    } = await loadThumbnailCacheModule();

    const deferredByPath = new Map<string, ReturnType<typeof createDeferred<string>>>();
    getThumbnailMock.mockImplementation((path: string) => {
      let deferred = deferredByPath.get(path);
      if (!deferred) {
        deferred = createDeferred<string>();
        deferredByPath.set(path, deferred);
      }
      return deferred.promise;
    });

    const droppedListener = vi.fn();
    const keptListener = vi.fn();
    const paths = [
      'C:/images/a.jpg',
      'C:/images/b.jpg',
      'C:/images/c.jpg',
      'C:/images/d.jpg',
    ];

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

    evictThumbnailsExcept(new Set(['C:/images/c.jpg']), 2);

    deferredByPath.get('C:/images/a.jpg')?.resolve('data:image/jpeg;base64,A');
    deferredByPath.get('C:/images/b.jpg')?.resolve('data:image/jpeg;base64,B');
    deferredByPath.get('C:/images/c.jpg')?.resolve('data:image/jpeg;base64,C');
    deferredByPath.get('C:/images/d.jpg')?.resolve('data:image/jpeg;base64,D');

    await Promise.all(paths.map((path) => loadThumbnail(path).catch(() => undefined)));

    expect(getCachedThumbnail('C:/images/a.jpg')).toBeUndefined();
    expect(getCachedThumbnail('C:/images/b.jpg')).toBeUndefined();
    expect(getCachedThumbnail('C:/images/c.jpg')).toBe('data:image/jpeg;base64,C');
    expect(getCachedThumbnail('C:/images/d.jpg')).toBe('data:image/jpeg;base64,D');
    expect(droppedListener).not.toHaveBeenCalled();
    expect(keptListener).toHaveBeenCalledTimes(1);

    clearThumbnailCacheForTests();
  });
});

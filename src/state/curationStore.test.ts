import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurationStore } from './curationStore';

const {
  readCurationMetadataMock,
  readCurationMetadataForPathsMock,
  writeImageCurationMock,
  writeImageCurationBatchMock,
  clearImageCurationMock,
  resetImageReviewDecisionMock,
} = vi.hoisted(() => ({
  readCurationMetadataMock: vi.fn(),
  readCurationMetadataForPathsMock: vi.fn(),
  writeImageCurationMock: vi.fn(),
  writeImageCurationBatchMock: vi.fn((): Promise<void> => Promise.resolve()),
  clearImageCurationMock: vi.fn(),
  resetImageReviewDecisionMock: vi.fn(),
}));

vi.mock('../services/tauriCommands', () => ({
  readCurationMetadata: readCurationMetadataMock,
  readCurationMetadataForPaths: readCurationMetadataForPathsMock,
  writeImageCuration: writeImageCurationMock,
  writeImageCurationBatch: writeImageCurationBatchMock,
  clearImageCuration: clearImageCurationMock,
  resetImageReviewDecision: resetImageReviewDecisionMock,
}));

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('curationStore', () => {
  beforeEach(() => {
    useCurationStore.setState({
      curationByPath: {},
      favoritePaths: new Set(),
      isLoaded: false,
      loadStatus: 'idle',
      loadError: null,
      mutationStatus: 'idle',
      mutationError: null,
      failedOperation: null,
      errorDismissed: false,
    });
    vi.clearAllMocks();
  });

  it('loads curation metadata and normalizes ratings', async () => {
    readCurationMetadataMock.mockResolvedValue({
      'C:/images/one.jpg': {
        path: '',
        favorite: true,
        rating: 9,
        updated_at: 10,
      },
      'C:/images/two.jpg': {
        path: 'C:/images/two.jpg',
        favorite: false,
        rating: 0,
        updated_at: 11,
      },
    });

    await useCurationStore.getState().loadCuration();

    const state = useCurationStore.getState();
    expect(state.isLoaded).toBe(true);
    expect(state.curationByPath['C:/images/one.jpg']).toEqual({
      path: 'C:/images/one.jpg',
      favorite: true,
      rating: 5,
      reviewStatus: 'keep',
      updated_at: 10,
    });
    expect(state.curationByPath['C:/images/two.jpg']).toBeUndefined();
  });

  it('merges targeted folder hydration without dropping startup records outside the folder', async () => {
    readCurationMetadataMock.mockResolvedValue({
      'C:/outside.jpg': { path: 'C:/outside.jpg', favorite: true, rating: 1, updated_at: 1 },
    });
    await useCurationStore.getState().loadCuration();

    readCurationMetadataForPathsMock.mockResolvedValue({
      'C:/active.jpg': { path: 'C:/active.jpg', favorite: true, rating: 5, updated_at: 2 },
    });
    await useCurationStore.getState().loadCuration(['C:/active.jpg']);

    const state = useCurationStore.getState();
    expect(state.curationByPath['C:/outside.jpg']).toBeDefined();
    expect(state.curationByPath['C:/active.jpg']).toMatchObject({ rating: 5 });
  });

  it('toggles favorite for the current path and persists metadata', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);

    await useCurationStore.getState().toggleFavorite('C:/images/photo.jpg');

    expect(writeImageCurationMock).toHaveBeenCalledWith(
      'C:/images/photo.jpg',
      true,
      0,
      'unreviewed'
    );
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      path: 'C:/images/photo.jpg',
      favorite: true,
      rating: 0,
      reviewStatus: 'unreviewed',
    });
  });

  it('preserves explicit unreviewed status on a rated image', async () => {
    readCurationMetadataMock.mockResolvedValue({
      'C:/images/rated.jpg': {
        path: 'C:/images/rated.jpg',
        favorite: false,
        rating: 4,
        reviewStatus: 'unreviewed',
        updated_at: 10,
      },
    });

    await useCurationStore.getState().loadCuration();

    expect(useCurationStore.getState().curationByPath['C:/images/rated.jpg']).toMatchObject({
      rating: 4,
      reviewStatus: 'unreviewed',
    });
  });

  it('updates a large curation index in place for a single confirmed mutation', async () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => {
        const path = `C:/library/${index}.jpg`;
        return [path, { path, favorite: true, rating: 1, updated_at: 1 }];
      })
    );
    readCurationMetadataMock.mockResolvedValue(metadata);
    writeImageCurationMock.mockResolvedValue(undefined);

    await useCurationStore.getState().loadCuration();
    const index = useCurationStore.getState().curationIndex;
    await useCurationStore.getState().setRating('C:/library/5000.jpg', 5);

    expect(useCurationStore.getState().curationIndex).toBe(index);
    expect(index.entries.size).toBe(10_000);
    expect(index.entries.get('C:/library/5000.jpg')?.rating).toBe(5);
  });

  it('allows favorite to be removed from an already high-rated image', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);
    useCurationStore.setState({
      curationByPath: {
        'C:/images/photo.jpg': {
          path: 'C:/images/photo.jpg',
          favorite: true,
          rating: 5,
          reviewStatus: 'keep',
          updated_at: 10,
        },
      },
      isLoaded: true,
    });

    await useCurationStore.getState().toggleFavorite('C:/images/photo.jpg');

    expect(writeImageCurationMock).toHaveBeenCalledWith('C:/images/photo.jpg', false, 5, 'keep');
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: false,
      rating: 5,
    });
  });

  it('promotes 4-star and 5-star ratings to favorites', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);

    await useCurationStore.getState().setRating('C:/images/photo.jpg', 8);

    expect(writeImageCurationMock).toHaveBeenCalledWith(
      'C:/images/photo.jpg',
      true,
      5,
      'unreviewed'
    );
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: true,
      rating: 5,
    });

    await useCurationStore.getState().setRating('C:/images/photo.jpg', 0);

    expect(writeImageCurationMock).toHaveBeenLastCalledWith(
      'C:/images/photo.jpg',
      true,
      0,
      'unreviewed'
    );
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: true,
      rating: 0,
    });
  });

  it('clears default-state entries for non-favorite low ratings', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);

    await useCurationStore.getState().setRating('C:/images/photo.jpg', 3);

    expect(writeImageCurationMock).toHaveBeenCalledWith(
      'C:/images/photo.jpg',
      false,
      3,
      'unreviewed'
    );
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: false,
      rating: 3,
      reviewStatus: 'unreviewed',
    });

    await useCurationStore.getState().setRating('C:/images/photo.jpg', 0);

    expect(writeImageCurationMock).toHaveBeenLastCalledWith(
      'C:/images/photo.jpg',
      false,
      0,
      'unreviewed'
    );
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toBeUndefined();
  });

  it('clears metadata for a path', async () => {
    clearImageCurationMock.mockResolvedValue(undefined);
    useCurationStore.setState({
      curationByPath: {
        'C:/images/photo.jpg': {
          path: 'C:/images/photo.jpg',
          favorite: true,
          rating: 3,
          reviewStatus: 'reject',
          updated_at: 10,
        },
      },
      isLoaded: true,
    });

    await useCurationStore.getState().clearImageCuration('C:/images/photo.jpg');

    expect(clearImageCurationMock).toHaveBeenCalledWith('C:/images/photo.jpg');
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toBeUndefined();
  });

  it('sets favorite state for multiple paths', async () => {
    writeImageCurationBatchMock.mockResolvedValue(undefined);
    useCurationStore.setState({
      curationByPath: {
        'C:/images/two.jpg': {
          path: 'C:/images/two.jpg',
          favorite: true,
          rating: 4,
          reviewStatus: 'keep',
          updated_at: 10,
        },
      },
      isLoaded: true,
    });

    await useCurationStore
      .getState()
      .setFavoriteForPaths(['C:/images/one.jpg', 'C:/images/two.jpg', 'C:/images/one.jpg'], false);

    expect(writeImageCurationBatchMock).toHaveBeenCalledTimes(1);
    expect(writeImageCurationBatchMock).toHaveBeenCalledWith([
      { filePath: 'C:/images/one.jpg', favorite: false, rating: 0, reviewStatus: 'unreviewed' },
      { filePath: 'C:/images/two.jpg', favorite: false, rating: 4, reviewStatus: 'keep' },
    ]);
    expect(writeImageCurationMock).not.toHaveBeenCalled();
    expect(useCurationStore.getState().curationByPath['C:/images/one.jpg']).toBeUndefined();
    expect(useCurationStore.getState().curationByPath['C:/images/two.jpg']).toMatchObject({
      favorite: false,
      rating: 4,
      reviewStatus: 'keep',
    });
  });

  it('sets and resets review decisions without changing rating or favorite', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);
    resetImageReviewDecisionMock.mockResolvedValue(undefined);
    useCurationStore.setState({
      curationByPath: {
        'C:/images/photo.jpg': {
          path: 'C:/images/photo.jpg',
          favorite: true,
          rating: 5,
          reviewStatus: 'keep',
          updated_at: 10,
        },
      },
      isLoaded: true,
    });

    await useCurationStore.getState().setReviewStatus('C:/images/photo.jpg', 'reject');
    await useCurationStore.getState().resetReviewDecision('C:/images/photo.jpg');

    expect(writeImageCurationMock).toHaveBeenCalledWith('C:/images/photo.jpg', true, 5, 'reject');
    expect(resetImageReviewDecisionMock).toHaveBeenCalledWith('C:/images/photo.jpg');
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: true,
      rating: 5,
      reviewStatus: 'unreviewed',
    });
  });

  it.each(['keep', 'reject', 'unreviewed'] as const)(
    'preserves an unfavorited high rating during a bulk %s decision',
    async (reviewStatus) => {
      writeImageCurationBatchMock.mockResolvedValue(undefined);
      useCurationStore.setState({
        curationByPath: {
          'C:/images/photo.jpg': {
            path: 'C:/images/photo.jpg',
            favorite: false,
            rating: 5,
            reviewStatus: 'keep',
            updated_at: 10,
          },
        },
      });

      await useCurationStore
        .getState()
        .setReviewStatusForPaths(['C:/images/photo.jpg'], reviewStatus);

      expect(writeImageCurationBatchMock).toHaveBeenCalledWith([
        { filePath: 'C:/images/photo.jpg', favorite: false, rating: 5, reviewStatus },
      ]);
      expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
        favorite: false,
        rating: 5,
        reviewStatus,
      });
    }
  );

  it('rejects malformed single review statuses without writing fallback metadata', async () => {
    await expect(
      useCurationStore.getState().setReviewStatus('C:/images/photo.jpg', 'maybe' as never)
    ).rejects.toThrow('Invalid review status: maybe');

    expect(writeImageCurationMock).not.toHaveBeenCalled();
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toBeUndefined();
    expect(useCurationStore.getState()).toMatchObject({
      mutationStatus: 'error',
      mutationError: 'Invalid review status: maybe',
      failedOperation: {
        intent: {
          kind: 'setReviewStatus',
          filePath: 'C:/images/photo.jpg',
          reviewStatus: 'maybe',
        },
      },
    });
  });

  it('rejects malformed batch review statuses without writing fallback metadata', async () => {
    await expect(
      useCurationStore.getState().setReviewStatusForPaths(['C:/images/photo.jpg'], 'maybe' as never)
    ).rejects.toThrow('Invalid review status: maybe');

    expect(writeImageCurationBatchMock).not.toHaveBeenCalled();
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toBeUndefined();
  });

  it('keeps failed batch decisions out of local state and retries the same decision', async () => {
    writeImageCurationBatchMock
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    const paths = ['C:/images/one.jpg', 'C:/images/two.jpg'];

    await expect(
      useCurationStore.getState().setReviewStatusForPaths(paths, 'reject')
    ).rejects.toThrow('disk full');
    expect(Object.keys(useCurationStore.getState().curationByPath)).toEqual([]);
    expect(useCurationStore.getState().mutationStatus).toBe('error');

    await useCurationStore.getState().retryLastFailedOperation();

    expect(writeImageCurationBatchMock).toHaveBeenCalledTimes(2);
    for (const path of paths) {
      expect(useCurationStore.getState().curationByPath[path]?.reviewStatus).toBe('reject');
    }
    expect(useCurationStore.getState().mutationStatus).toBe('idle');
  });

  it('sets ratings for multiple paths and promotes high ratings to favorites', async () => {
    writeImageCurationBatchMock.mockResolvedValue(undefined);

    await useCurationStore
      .getState()
      .setRatingForPaths(['C:/images/one.jpg', 'C:/images/two.jpg'], 5);

    expect(writeImageCurationBatchMock).toHaveBeenCalledTimes(1);
    expect(writeImageCurationBatchMock).toHaveBeenCalledWith([
      { filePath: 'C:/images/one.jpg', favorite: true, rating: 5, reviewStatus: 'unreviewed' },
      { filePath: 'C:/images/two.jpg', favorite: true, rating: 5, reviewStatus: 'unreviewed' },
    ]);
    expect(writeImageCurationMock).not.toHaveBeenCalled();
    expect(useCurationStore.getState().curationByPath['C:/images/one.jpg']).toMatchObject({
      favorite: true,
      rating: 5,
    });
    expect(useCurationStore.getState().curationByPath['C:/images/two.jpg']).toMatchObject({
      favorite: true,
      rating: 5,
    });
  });

  it('queues overlapping bulk curation changes against the latest state', async () => {
    const firstBatch = createDeferredVoid();
    writeImageCurationBatchMock
      .mockReturnValueOnce(firstBatch.promise)
      .mockResolvedValueOnce(undefined);

    const favoritePromise = useCurationStore
      .getState()
      .setFavoriteForPaths(['C:/images/one.jpg'], true);
    const ratingPromise = useCurationStore.getState().setRatingForPaths(['C:/images/one.jpg'], 2);

    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(writeImageCurationBatchMock).toHaveBeenCalledTimes(1);

    firstBatch.resolve();
    await Promise.all([favoritePromise, ratingPromise]);

    expect(writeImageCurationBatchMock).toHaveBeenNthCalledWith(1, [
      { filePath: 'C:/images/one.jpg', favorite: true, rating: 0, reviewStatus: 'unreviewed' },
    ]);
    expect(writeImageCurationBatchMock).toHaveBeenNthCalledWith(2, [
      { filePath: 'C:/images/one.jpg', favorite: true, rating: 2, reviewStatus: 'unreviewed' },
    ]);
    expect(useCurationStore.getState().curationByPath['C:/images/one.jpg']).toMatchObject({
      favorite: true,
      rating: 2,
    });
  });

  it('rejects failed writes, exposes a retryable intent, and allows later writes to proceed', async () => {
    writeImageCurationMock
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    await expect(
      useCurationStore.getState().toggleFavorite('C:/images/failed.jpg')
    ).rejects.toThrow('disk full');
    expect(useCurationStore.getState()).toMatchObject({
      mutationStatus: 'error',
      mutationError: 'disk full',
      failedOperation: { intent: { kind: 'toggleFavorite', filePath: 'C:/images/failed.jpg' } },
    });

    await expect(
      useCurationStore.getState().toggleFavorite('C:/images/later.jpg')
    ).resolves.toBeUndefined();
    expect(useCurationStore.getState().mutationStatus).toBe('idle');
    expect(useCurationStore.getState().curationByPath['C:/images/later.jpg']).toBeDefined();
  });

  it('retries the latest failed intent and clears the error only after success', async () => {
    writeImageCurationMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);

    await expect(useCurationStore.getState().setRating('C:/images/retry.jpg', 3)).rejects.toThrow();
    await expect(useCurationStore.getState().retryLastFailedOperation()).resolves.toBeUndefined();
    expect(writeImageCurationMock).toHaveBeenNthCalledWith(
      2,
      'C:/images/retry.jpg',
      false,
      3,
      'unreviewed'
    );
    expect(useCurationStore.getState()).toMatchObject({
      mutationStatus: 'idle',
      mutationError: null,
      failedOperation: null,
    });
  });

  it('keeps initial-load failures separate from mutation state', async () => {
    readCurationMetadataMock.mockRejectedValueOnce(new Error('metadata unavailable'));
    await expect(useCurationStore.getState().loadCuration()).rejects.toThrow(
      'metadata unavailable'
    );
    expect(useCurationStore.getState()).toMatchObject({
      isLoaded: true,
      loadStatus: 'error',
      loadError: 'metadata unavailable',
      mutationStatus: 'idle',
    });
  });
});

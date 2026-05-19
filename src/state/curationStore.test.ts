import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurationStore } from './curationStore';

const {
  readCurationMetadataMock,
  writeImageCurationMock,
  writeImageCurationBatchMock,
  clearImageCurationMock,
} = vi.hoisted(() => ({
  readCurationMetadataMock: vi.fn(),
  writeImageCurationMock: vi.fn(),
  writeImageCurationBatchMock: vi.fn((): Promise<void> => Promise.resolve()),
  clearImageCurationMock: vi.fn(),
}));

vi.mock('../services/tauriCommands', () => ({
  readCurationMetadata: readCurationMetadataMock,
  writeImageCuration: writeImageCurationMock,
  writeImageCurationBatch: writeImageCurationBatchMock,
  clearImageCuration: clearImageCurationMock,
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
    useCurationStore.setState({ curationByPath: {}, isLoaded: false });
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
      updated_at: 10,
    });
    expect(state.curationByPath['C:/images/two.jpg']).toBeUndefined();
  });

  it('toggles favorite for the current path and persists metadata', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);

    await useCurationStore.getState().toggleFavorite('C:/images/photo.jpg');

    expect(writeImageCurationMock).toHaveBeenCalledWith('C:/images/photo.jpg', true, 0);
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      path: 'C:/images/photo.jpg',
      favorite: true,
      rating: 0,
    });
  });

  it('allows favorite to be removed from an already high-rated image', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);
    useCurationStore.setState({
      curationByPath: {
        'C:/images/photo.jpg': {
          path: 'C:/images/photo.jpg',
          favorite: true,
          rating: 5,
          updated_at: 10,
        },
      },
      isLoaded: true,
    });

    await useCurationStore.getState().toggleFavorite('C:/images/photo.jpg');

    expect(writeImageCurationMock).toHaveBeenCalledWith('C:/images/photo.jpg', false, 5);
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: false,
      rating: 5,
    });
  });

  it('promotes 4-star and 5-star ratings to favorites', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);

    await useCurationStore.getState().setRating('C:/images/photo.jpg', 8);

    expect(writeImageCurationMock).toHaveBeenCalledWith('C:/images/photo.jpg', true, 5);
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: true,
      rating: 5,
    });

    await useCurationStore.getState().setRating('C:/images/photo.jpg', 0);

    expect(writeImageCurationMock).toHaveBeenLastCalledWith('C:/images/photo.jpg', true, 0);
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: true,
      rating: 0,
    });
  });

  it('clears default-state entries for non-favorite low ratings', async () => {
    writeImageCurationMock.mockResolvedValue(undefined);

    await useCurationStore.getState().setRating('C:/images/photo.jpg', 3);

    expect(writeImageCurationMock).toHaveBeenCalledWith('C:/images/photo.jpg', false, 3);
    expect(useCurationStore.getState().curationByPath['C:/images/photo.jpg']).toMatchObject({
      favorite: false,
      rating: 3,
    });

    await useCurationStore.getState().setRating('C:/images/photo.jpg', 0);

    expect(writeImageCurationMock).toHaveBeenLastCalledWith('C:/images/photo.jpg', false, 0);
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
      { filePath: 'C:/images/one.jpg', favorite: false, rating: 0 },
      { filePath: 'C:/images/two.jpg', favorite: false, rating: 4 },
    ]);
    expect(writeImageCurationMock).not.toHaveBeenCalled();
    expect(useCurationStore.getState().curationByPath['C:/images/one.jpg']).toBeUndefined();
    expect(useCurationStore.getState().curationByPath['C:/images/two.jpg']).toMatchObject({
      favorite: false,
      rating: 4,
    });
  });

  it('sets ratings for multiple paths and promotes high ratings to favorites', async () => {
    writeImageCurationBatchMock.mockResolvedValue(undefined);

    await useCurationStore
      .getState()
      .setRatingForPaths(['C:/images/one.jpg', 'C:/images/two.jpg'], 5);

    expect(writeImageCurationBatchMock).toHaveBeenCalledTimes(1);
    expect(writeImageCurationBatchMock).toHaveBeenCalledWith([
      { filePath: 'C:/images/one.jpg', favorite: true, rating: 5 },
      { filePath: 'C:/images/two.jpg', favorite: true, rating: 5 },
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
      { filePath: 'C:/images/one.jpg', favorite: true, rating: 0 },
    ]);
    expect(writeImageCurationBatchMock).toHaveBeenNthCalledWith(2, [
      { filePath: 'C:/images/one.jpg', favorite: true, rating: 2 },
    ]);
    expect(useCurationStore.getState().curationByPath['C:/images/one.jpg']).toMatchObject({
      favorite: true,
      rating: 2,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetDirectCurationActionStateForTests,
  toggleFavoriteFromUi,
  toggleMarkFromUi,
} from './directCurationActions';
import { useCurationStore } from '../state/curationStore';
import { useToastStore } from '../state/toastStore';
import { useViewerStore } from '../state/viewerStore';

const { writeImageCurationMock, writeImageCurationBatchMock } = vi.hoisted(() => ({
  writeImageCurationMock: vi.fn(),
  writeImageCurationBatchMock: vi.fn(async () => undefined),
}));

vi.mock('../services/tauriCommands', () => ({
  clearImageCuration: vi.fn(async () => undefined),
  readCurationMetadata: vi.fn(async () => ({})),
  readCurationMetadataForPaths: vi.fn(async () => ({})),
  writeImageCuration: writeImageCurationMock,
  writeImageCurationBatch: writeImageCurationBatchMock,
}));

const imageA = {
  path: 'C:/images/a.jpg',
  file_name: 'a.jpg',
  extension: 'jpg',
  size_bytes: 1,
  modified_at: '1',
};
const imageB = { ...imageA, path: 'C:/images/b.jpg', file_name: 'b.jpg' };

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const queuedToggleFavorite = useCurationStore.getState().toggleFavorite;
const queuedSetRating = useCurationStore.getState().setRating;

function setFavorite(path: string, favorite: boolean) {
  const entries = { ...useCurationStore.getState().curationByPath };
  if (favorite) {
    entries[path] = { path, favorite: true, rating: 0, updated_at: 1 };
  } else {
    delete entries[path];
  }
  useCurationStore.setState({ curationByPath: entries });
}

describe('direct curation action feedback', () => {
  beforeEach(() => {
    resetDirectCurationActionStateForTests();
    useToastStore.getState().clearToasts();
    useViewerStore.getState().reset();
    useViewerStore.setState({ images: [imageA, imageB], currentIndex: 0 });
    useCurationStore.setState({ curationByPath: {} });
    writeImageCurationMock.mockReset();
    useCurationStore.setState({
      toggleFavorite: vi.fn(async (path: string) => {
        const current = Boolean(useCurationStore.getState().curationByPath[path]?.favorite);
        setFavorite(path, !current);
      }),
    });
  });

  it('reports the completed favourite and mark states', async () => {
    useViewerStore.setState({ isSlideshowActive: true });
    await toggleFavoriteFromUi(imageA.path);
    await toggleFavoriteFromUi(imageA.path);
    toggleMarkFromUi(imageA.path);
    toggleMarkFromUi(imageA.path);

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toMatchObject({
      kind: 'success',
      title: 'Removed from favourites',
      message: '',
      duration: 2000,
    });
    expect(toasts[1]).toMatchObject({
      kind: 'success',
      title: 'Unmarked',
      message: '',
      duration: 2000,
    });
  });

  it('keeps the captured filename and slideshow feedback after navigation and slideshow exit', async () => {
    let resolveWrite!: () => void;
    useCurationStore.setState({
      toggleFavorite: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = () => {
              setFavorite(imageA.path, true);
              resolve();
            };
          })
      ),
    });
    useViewerStore.setState({ isSlideshowActive: true });
    const action = toggleFavoriteFromUi(imageA.path);
    await Promise.resolve();
    useViewerStore.setState({ currentIndex: 1, isSlideshowActive: false });
    resolveWrite();
    await action;

    expect(useToastStore.getState().toasts).toMatchObject([{ title: 'Favourited', message: '' }]);
  });

  it('serializes rapid favourite actions and reports their actual final results', async () => {
    useViewerStore.setState({ isSlideshowActive: true });
    await Promise.all([
      toggleFavoriteFromUi(imageA.path),
      toggleFavoriteFromUi(imageA.path),
      toggleFavoriteFromUi(imageB.path),
    ]);

    expect(Boolean(useCurationStore.getState().curationByPath[imageA.path]?.favorite)).toBe(false);
    expect(useCurationStore.getState().curationByPath[imageB.path]?.favorite).toBe(true);
    expect(useToastStore.getState().toasts).toMatchObject([{ title: 'Favourited', message: '' }]);
  });

  it('starts F/F immediately and preserves the curation queue before rating 5', async () => {
    useViewerStore.setState({ isSlideshowActive: true });
    const firstWrite = createDeferredVoid();
    const secondWrite = createDeferredVoid();
    const ratingWrite = createDeferredVoid();
    writeImageCurationMock
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise)
      .mockImplementationOnce(() => ratingWrite.promise);

    const firstFavorite = toggleFavoriteFromUi(imageA.path, undefined, queuedToggleFavorite);
    const secondFavorite = toggleFavoriteFromUi(imageA.path, undefined, queuedToggleFavorite);
    const rating = queuedSetRating(imageA.path, 5);

    // The UI wrapper must enqueue all three intents in the store immediately. The store's own
    // queue then serializes their deferred backend writes and computes F/F from each prior state.
    await vi.waitFor(() => expect(writeImageCurationMock).toHaveBeenCalledTimes(1));
    expect(writeImageCurationMock).toHaveBeenNthCalledWith(1, imageA.path, true, 0);

    firstWrite.resolve();
    await vi.waitFor(() => expect(useToastStore.getState().toasts[0]?.title).toBe('Favourited'));
    await vi.waitFor(() => expect(writeImageCurationMock).toHaveBeenCalledTimes(2));
    expect(writeImageCurationMock).toHaveBeenNthCalledWith(2, imageA.path, false, 0);

    secondWrite.resolve();
    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.title).toBe('Removed from favourites')
    );
    await vi.waitFor(() => expect(writeImageCurationMock).toHaveBeenCalledTimes(3));
    expect(writeImageCurationMock).toHaveBeenNthCalledWith(3, imageA.path, true, 5);

    ratingWrite.resolve();
    await Promise.all([firstFavorite, secondFavorite, rating]);
    expect(useCurationStore.getState().curationByPath[imageA.path]).toMatchObject({
      favorite: true,
      rating: 5,
    });
    expect(useToastStore.getState().toasts).toMatchObject([
      { title: 'Removed from favourites', message: '' },
    ]);
  });

  it('shows only the latest success per category and preserves errors and unrelated toasts', async () => {
    useViewerStore.setState({ isSlideshowActive: true });
    useToastStore.getState().pushToast({ kind: 'info', title: 'Other', message: 'Keep me' });
    await toggleFavoriteFromUi(imageA.path);
    await toggleFavoriteFromUi(imageA.path);
    useCurationStore.setState({
      toggleFavorite: vi.fn(async () => {
        useCurationStore.setState({ mutationStatus: 'error', mutationError: 'disk full' });
        throw new Error('disk full');
      }),
    });
    await toggleFavoriteFromUi(imageB.path);
    toggleMarkFromUi(imageA.path);

    expect(useToastStore.getState().toasts.map(({ title }) => title)).toEqual([
      'Other',
      'Removed from favourites',
      'Could not update favourite',
      'Marked',
    ]);
    expect(useCurationStore.getState().mutationError).toBe('disk full');
  });

  it('omits image details from success feedback', async () => {
    useViewerStore.setState({ isSlideshowActive: true });

    await toggleFavoriteFromUi(imageA.path);
    toggleMarkFromUi(imageA.path);

    expect(useToastStore.getState().toasts).toMatchObject([
      { title: 'Favourited', message: '' },
      { title: 'Marked', message: '' },
    ]);
  });

  it('does nothing for missing images and keeps normal-view success behavior unchanged', async () => {
    await toggleFavoriteFromUi('missing.jpg');
    toggleMarkFromUi('missing.jpg');
    await toggleFavoriteFromUi(imageA.path);
    toggleMarkFromUi(imageA.path);

    expect(useToastStore.getState().toasts).toEqual([]);
  });
});

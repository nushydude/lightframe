import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppKeyboardShortcuts } from './useAppKeyboardShortcuts';
import { useCurationStore } from '../state/curationStore';
import { useToastStore } from '../state/toastStore';
import { useViewerStore } from '../state/viewerStore';

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('useAppKeyboardShortcuts curation wiring', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
    useToastStore.getState().clearToasts();
    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
      isSlideshowActive: true,
      viewMode: 'grid',
    });
    useCurationStore.setState({ curationByPath: {} });
  });

  it('routes F and M keydowns through direct actions exactly once', async () => {
    const toggleFavorite = vi.fn(async () => undefined);
    const { unmount } = renderHook(() =>
      useAppKeyboardShortcuts({
        openFilePicker: vi.fn(),
        goNext: vi.fn(() => true),
        goPrev: vi.fn(() => true),
        goFirst: vi.fn(),
        goLast: vi.fn(),
        refreshFolder: vi.fn(),
        startSlideshow: vi.fn(),
        stopSlideshow: vi.fn(),
        toggleSlideshowPause: vi.fn(),
        openCommandPalette: vi.fn(),
        togglePerformanceTelemetry: vi.fn(),
        handleExitGridView: vi.fn(async () => true),
        toggleFavorite,
        setRating: vi.fn(),
      })
    );

    const markEvent = new KeyboardEvent('keydown', {
      key: 'm',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(markEvent);
    });
    expect(markEvent.defaultPrevented).toBe(true);
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/images/current.jpg']);
    expect(useToastStore.getState().toasts).toMatchObject([
      { title: 'Marked', message: 'current.jpg · 1 marked' },
    ]);

    const favoriteEvent = new KeyboardEvent('keydown', {
      key: 'f',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(favoriteEvent);
    });
    await waitFor(() => expect(toggleFavorite).toHaveBeenCalledTimes(1));

    unmount();
  });

  it('starts F/F immediately so a deferred rating write keeps queue order and feedback', async () => {
    const firstWrite = createDeferredVoid();
    const secondWrite = createDeferredVoid();
    const ratingWrite = createDeferredVoid();
    const order: string[] = [];
    const applyCuration = (favorite: boolean, rating = 0) => {
      useCurationStore.setState({
        curationByPath: {
          'C:/images/current.jpg': {
            path: 'C:/images/current.jpg',
            favorite,
            rating,
            updated_at: 1,
          },
        },
      });
    };
    const toggleFavorite = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push('favorite-on');
        return firstWrite.promise.then(() => applyCuration(true));
      })
      .mockImplementationOnce(() => {
        order.push('favorite-off');
        return secondWrite.promise.then(() => applyCuration(false));
      });
    const setRating = vi.fn((_: string, rating: number) => {
      order.push(`rating-${rating}`);
      return ratingWrite.promise.then(() => applyCuration(true, rating));
    });

    const { unmount } = renderHook(() =>
      useAppKeyboardShortcuts({
        openFilePicker: vi.fn(),
        goNext: vi.fn(() => true),
        goPrev: vi.fn(() => true),
        goFirst: vi.fn(),
        goLast: vi.fn(),
        refreshFolder: vi.fn(),
        startSlideshow: vi.fn(),
        stopSlideshow: vi.fn(),
        toggleSlideshowPause: vi.fn(),
        openCommandPalette: vi.fn(),
        togglePerformanceTelemetry: vi.fn(),
        handleExitGridView: vi.fn(async () => true),
        toggleFavorite,
        setRating,
      })
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', cancelable: true }));
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '5', altKey: true, cancelable: true })
      );
    });

    expect(toggleFavorite).toHaveBeenCalledTimes(2);
    expect(setRating).toHaveBeenCalledWith('C:/images/current.jpg', 5);
    expect(order).toEqual(['favorite-on', 'favorite-off', 'rating-5']);

    firstWrite.resolve();
    await waitFor(() => expect(useToastStore.getState().toasts[0]?.title).toBe('Favourited'));
    secondWrite.resolve();
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.title).toBe('Removed from favourites')
    );
    ratingWrite.resolve();
    await waitFor(() =>
      expect(useCurationStore.getState().curationByPath['C:/images/current.jpg']).toMatchObject({
        favorite: true,
        rating: 5,
      })
    );

    unmount();
  });
});

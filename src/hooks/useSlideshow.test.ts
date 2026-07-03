import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import { useSlideshow } from './useSlideshow';

const images = [
  {
    path: 'C:/images/1.jpg',
    file_name: '1.jpg',
    extension: 'jpg',
    size_bytes: 1,
    modified_at: '1',
  },
  {
    path: 'C:/images/2.jpg',
    file_name: '2.jpg',
    extension: 'jpg',
    size_bytes: 1,
    modified_at: '1',
  },
  {
    path: 'C:/images/3.jpg',
    file_name: '3.jpg',
    extension: 'jpg',
    size_bytes: 1,
    modified_at: '1',
  },
];

describe('useSlideshow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useViewerStore.getState().reset();
    useViewerStore.setState({
      currentImagePath: images[0].path,
      currentIndex: 0,
      images,
    });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        autoFullscreenOnSlideshow: false,
        loopSlideshow: false,
        shuffleSlideshow: false,
        slideshowIntervalSeconds: 4,
      },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts the slide timer when navigation changes the current image manually', async () => {
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    await act(async () => {
      useViewerStore.getState().setCurrentIndex(1);
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(3999);
    });

    expect(useViewerStore.getState().currentIndex).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(useViewerStore.getState().currentIndex).toBe(2);
  });

  it('starts without changing view mode because App owns grid-exit cleanup', async () => {
    useViewerStore.setState({ viewMode: 'grid' });
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
    });

    expect(useViewerStore.getState().viewMode).toBe('grid');
    expect(useViewerStore.getState().isSlideshowActive).toBe(true);
  });

  it('does not rerender when unrelated persisted mark settings change', () => {
    let renderCount = 0;

    renderHook(() => {
      renderCount++;
      return useSlideshow();
    });

    expect(renderCount).toBe(1);

    act(() => {
      useSettingsStore.setState((state) => ({
        settings: {
          ...state.settings,
          persistedMarkedFolders: [
            {
              folderPath: 'C:/images',
              markedPaths: ['C:/images/1.jpg'],
              updatedAt: 1,
            },
          ],
        },
      }));
    });

    expect(renderCount).toBe(1);
  });

  it('preserves shuffle progress when new images are added mid-slideshow', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        shuffleSlideshow: true,
      },
    }));

    const randomValues = [0.99, 0.1, 0.99];
    const randomSpy = vi
      .spyOn(Math, 'random')
      .mockImplementation(() => randomValues.shift() ?? 0.5);

    try {
      const { result } = renderHook(() => useSlideshow());

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(useViewerStore.getState().currentIndex).toBe(1);

      act(() => {
        useViewerStore.setState((state) => ({
          images: [
            ...state.images,
            {
              path: 'C:/images/4.jpg',
              file_name: '4.jpg',
              extension: 'jpg',
              size_bytes: 1,
              modified_at: '1',
            },
          ],
        }));
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(useViewerStore.getState().currentImagePath).toBe('C:/images/3.jpg');

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(useViewerStore.getState().currentImagePath).toBe('C:/images/4.jpg');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('returns to window mode when stopping a fullscreen slideshow', async () => {
    useViewerStore.setState({ isFullscreen: true, isSlideshowActive: true });
    const mockWindow = getCurrentWindow();
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.stop();
    });

    expect(mockWindow.setFullscreen).toHaveBeenCalledWith(false);
    expect(useViewerStore.getState()).toMatchObject({
      isSlideshowActive: false,
      isFullscreen: false,
    });
  });
});

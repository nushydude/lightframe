import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
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
        slideshowDirection: 'forward',
        slideshowIntervalSeconds: 4,
      },
    }));
  });

  afterEach(() => {
    vi.mocked(invoke).mockReset();
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

  it('acquires display inhibition once for a running slideshow', async () => {
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });

    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'acquire_slideshow_display_inhibition')
    ).toHaveLength(1);
  });

  it('releases on pause and reacquires on resume without reacting to slide changes', async () => {
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    vi.mocked(invoke).mockClear();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(invoke).mock.calls).toHaveLength(0);

    act(() => result.current.togglePause());
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(invoke).mock.calls).toEqual([['release_slideshow_display_inhibition']]);

    vi.mocked(invoke).mockClear();
    act(() => result.current.togglePause());
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(invoke).mock.calls).toEqual([['acquire_slideshow_display_inhibition']]);
  });

  it('releases when the slideshow stops or the hook unmounts', async () => {
    const { result, unmount } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    vi.mocked(invoke).mockClear();
    await act(async () => {
      await result.current.stop();
      await Promise.resolve();
    });
    expect(vi.mocked(invoke).mock.calls).toEqual([['release_slideshow_display_inhibition']]);

    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    vi.mocked(invoke).mockClear();
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(invoke).mock.calls).toEqual([['release_slideshow_display_inhibition']]);
  });

  it('keeps playing when native inhibition fails', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'acquire_slideshow_display_inhibition') {
        throw new Error('native failure');
      }
      return undefined;
    });
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });

    expect(useViewerStore.getState().isSlideshowActive).toBe(true);
  });

  it('releases after a delayed acquire is followed by pause', async () => {
    let resolveAcquire!: () => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'acquire_slideshow_display_inhibition') {
        return new Promise<void>((resolve) => {
          resolveAcquire = resolve;
        });
      }
      return Promise.resolve();
    });
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
      await Promise.resolve();
    });
    act(() => result.current.togglePause());
    resolveAcquire();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      'acquire_slideshow_display_inhibition',
      'release_slideshow_display_inhibition',
    ]);
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

  it('advances to the previous image when direction is reverse', async () => {
    useViewerStore.setState({
      currentImagePath: images[2].path,
      currentIndex: 2,
    });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        slideshowDirection: 'reverse',
      },
    }));

    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
    });

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(useViewerStore.getState().currentIndex).toBe(1);
  });

  it('loops from the first image to the last image in reverse direction', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        loopSlideshow: true,
        slideshowDirection: 'reverse',
      },
    }));

    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.start();
    });

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(useViewerStore.getState().currentIndex).toBe(2);
  });

  it('walks a shuffled slideshow backward without stopping on the first tick', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        shuffleSlideshow: true,
        slideshowDirection: 'reverse',
      },
    }));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const { result } = renderHook(() => useSlideshow());

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(useViewerStore.getState().currentIndex).not.toBe(0);
      expect(useViewerStore.getState().isSlideshowActive).toBe(true);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('does not replay the starting image before stopping a non-looping reverse shuffle', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        shuffleSlideshow: true,
        slideshowDirection: 'reverse',
      },
    }));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const { result } = renderHook(() => useSlideshow());

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(useViewerStore.getState().currentImagePath).toBe('C:/images/2.jpg');

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(useViewerStore.getState().currentImagePath).toBe('C:/images/3.jpg');

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(useViewerStore.getState()).toMatchObject({
        currentImagePath: 'C:/images/3.jpg',
        isSlideshowActive: false,
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('keeps moving when a running shuffled slideshow changes to reverse before the first tick', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        shuffleSlideshow: true,
      },
    }));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);

    try {
      const { result } = renderHook(() => useSlideshow());

      await act(async () => {
        await result.current.start();
      });

      await act(async () => {
        useSettingsStore.setState((state) => ({
          ...state,
          settings: {
            ...state.settings,
            slideshowDirection: 'reverse',
          },
        }));
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(useViewerStore.getState()).toMatchObject({
        currentIndex: 2,
        isSlideshowActive: true,
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('keeps looping when a shuffled slideshow changes direction at the end of a cycle', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        loopSlideshow: true,
        shuffleSlideshow: true,
      },
    }));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);

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
        vi.advanceTimersByTime(4000);
      });
      expect(useViewerStore.getState().currentIndex).toBe(2);

      await act(async () => {
        useSettingsStore.setState((state) => ({
          ...state,
          settings: {
            ...state.settings,
            slideshowDirection: 'reverse',
          },
        }));
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(useViewerStore.getState().currentIndex).toBe(1);

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(useViewerStore.getState()).toMatchObject({
        currentIndex: 0,
        isSlideshowActive: true,
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('keeps every slide reachable when a looped shuffled slideshow changes direction mid-cycle', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        loopSlideshow: true,
        shuffleSlideshow: true,
      },
    }));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);

    try {
      const { result } = renderHook(() => useSlideshow());

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(useViewerStore.getState().currentIndex).toBe(1);

      await act(async () => {
        useSettingsStore.setState((state) => ({
          ...state,
          settings: {
            ...state.settings,
            slideshowDirection: 'reverse',
          },
        }));
        await Promise.resolve();
      });

      const visited = new Set([useViewerStore.getState().currentIndex]);
      const sequenceAfterToggle: number[] = [];
      for (let tick = 0; tick < 4; tick += 1) {
        act(() => {
          vi.advanceTimersByTime(4000);
        });
        const currentTickIndex = useViewerStore.getState().currentIndex;
        sequenceAfterToggle.push(currentTickIndex);
        visited.add(currentTickIndex);
      }

      expect(sequenceAfterToggle[0]).toBe(2);
      expect(visited).toEqual(new Set([0, 1, 2]));
      expect(useViewerStore.getState().isSlideshowActive).toBe(true);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('creates a fresh shuffle order when shuffle is enabled during a later active slideshow', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        shuffleSlideshow: true,
      },
    }));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);

    try {
      const { result } = renderHook(() => useSlideshow());

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(useViewerStore.getState().currentIndex).toBe(1);

      await act(async () => {
        await result.current.stop();
      });

      await act(async () => {
        useViewerStore.getState().setCurrentIndex(0);
        useSettingsStore.setState((state) => ({
          ...state,
          settings: {
            ...state.settings,
            shuffleSlideshow: false,
          },
        }));
        await result.current.start();
      });

      await act(async () => {
        useSettingsStore.setState((state) => ({
          ...state,
          settings: {
            ...state.settings,
            shuffleSlideshow: true,
          },
        }));
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(useViewerStore.getState()).toMatchObject({
        currentIndex: 1,
        isSlideshowActive: true,
      });
    } finally {
      randomSpy.mockRestore();
    }
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

  it('preserves reverse shuffle progress when new images are added mid-slideshow', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        shuffleSlideshow: true,
        slideshowDirection: 'reverse',
      },
    }));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const { result } = renderHook(() => useSlideshow());

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(useViewerStore.getState().currentImagePath).toBe('C:/images/2.jpg');

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

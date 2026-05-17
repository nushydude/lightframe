import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});

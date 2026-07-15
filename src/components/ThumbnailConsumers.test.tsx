import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThumbnailStrip } from './ThumbnailStrip';
import { ContactSheet } from './ContactSheet';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';

const {
  getCachedThumbnailMock,
  preloadThumbnailsMock,
  evictThumbnailsExceptMock,
  invalidateThumbnailMock,
} = vi.hoisted(() => ({
  getCachedThumbnailMock: vi.fn(() => undefined),
  preloadThumbnailsMock: vi.fn(),
  evictThumbnailsExceptMock: vi.fn(),
  invalidateThumbnailMock: vi.fn(),
}));

vi.mock('../services/thumbnailCache', () => ({
  evictThumbnailsExcept: evictThumbnailsExceptMock,
  getCachedThumbnail: getCachedThumbnailMock,
  invalidateThumbnail: invalidateThumbnailMock,
  preloadThumbnails: preloadThumbnailsMock,
}));

vi.mock('../hooks/useThumbnailRefreshSignal', () => ({
  useThumbnailRefreshSignal: () => ({
    handleThumbnailLoaded: vi.fn(),
    isThumbnailConsumerActive: () => true,
  }),
}));

vi.mock('../hooks/useProjectorState', () => ({
  useProjectorState: () => ({
    isProjectorOpen: false,
    refreshProjectorState: vi.fn(async () => undefined),
  }),
}));

vi.mock('../services/tauriCommands', () => ({
  closeSecondaryWindow: vi.fn(async () => undefined),
}));

vi.mock('../services/imageAssetCache', () => ({
  invalidateImageAsset: vi.fn(),
}));

vi.mock('../services/viewerActions', () => ({
  showTransferResultMessage: vi.fn(async () => undefined),
  transferImagesToDestination: vi.fn(async () => ({
    successes: [],
    failures: [],
  })),
}));

describe('thumbnail consumers', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    vi.clearAllMocks();
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        disconnect() {}
      }
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    useViewerStore.getState().reset();
    useCurationStore.setState({ curationByPath: {} });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        quickDestinations: [],
      },
    }));
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('renders a strip placeholder when no thumbnail URL is cached yet', () => {
    useViewerStore.setState({
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ThumbnailStrip />);

    expect(container.querySelector('.thumbnail-placeholder')).not.toBeNull();
  });

  it('renders a contact sheet placeholder when a thumbnail request has not completed', () => {
    useViewerStore.setState({
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
    });

    const { container } = render(
      <ContactSheet
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    expect(container.querySelector('.grid-placeholder')).not.toBeNull();
  });

  it('loads thumbnail strip items for the manually scrolled viewport', () => {
    const images = Array.from({ length: 100 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: '1',
    }));

    useViewerStore.setState({
      currentIndex: 0,
      currentImagePath: images[0].path,
      images,
    });

    const { container } = render(<ThumbnailStrip />);
    const stripContainer = container.querySelector('.thumbnail-strip-container') as HTMLDivElement;

    stripContainer.scrollLeft = 50 * 78;
    fireEvent.scroll(stripContainer);

    expect(
      preloadThumbnailsMock.mock.calls.some(([requests]) =>
        (requests as Array<{ path: string }>).some((request) => request.path === images[50].path)
      )
    ).toBe(true);
  });

  it('preloads around the current thumbnail before the first scroll sync', () => {
    const images = Array.from({ length: 100 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: '1',
    }));

    useViewerStore.setState({
      currentIndex: 80,
      currentImagePath: images[80].path,
      images,
    });

    render(<ThumbnailStrip />);

    const firstPreloadRequest = preloadThumbnailsMock.mock.calls[0]?.[0] as
      | Array<{ path: string }>
      | undefined;
    expect(firstPreloadRequest?.some((request) => request.path === images[80].path)).toBe(true);
    expect(firstPreloadRequest?.some((request) => request.path === images[0].path)).toBe(false);
  });

  it('focuses off-screen thumbnails after Home and End virtualize their slice', () => {
    const images = Array.from({ length: 100 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: String(index),
    }));
    useViewerStore.setState({ currentIndex: 0, images });

    render(<ThumbnailStrip />);
    const firstThumbnail = screen.getByRole('option', { name: '0.jpg' });
    fireEvent.keyDown(firstThumbnail, { key: 'End' });

    const lastThumbnail = screen.getByRole('option', { name: '99.jpg' });
    expect(document.activeElement).toBe(lastThumbnail);

    fireEvent.keyDown(lastThumbnail, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: '0.jpg' }));
  });

  it('does not navigate twice when an active thumbnail handles an arrow key', () => {
    const images = Array.from({ length: 3 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: String(index),
    }));
    const keyboardHandlers = {
      openFilePicker: vi.fn(),
      openCurrentImageInEditor: vi.fn(),
      copyCurrentImagePath: vi.fn(),
      goNext: vi.fn(() => useViewerStore.getState().navigateNext()),
      goPrev: vi.fn(() => useViewerStore.getState().navigatePrev()),
      goFirst: vi.fn(),
      goLast: vi.fn(),
      refreshFolder: vi.fn(),
      deleteCurrentImage: vi.fn(),
      startSlideshow: vi.fn(),
      stopSlideshow: vi.fn(),
      toggleSlideshowPause: vi.fn(),
      openCommandPalette: vi.fn(),
      toggleGridView: vi.fn(),
      togglePerformanceTelemetry: vi.fn(),
      toggleFavoriteCurrent: vi.fn(),
      toggleMarkedCurrent: vi.fn(),
      setRatingCurrent: vi.fn(),
    };

    useViewerStore.setState({
      currentIndex: 0,
      currentImagePath: images[0].path,
      images,
    });

    render(<ThumbnailStrip />);
    renderHook(() => useKeyboardShortcuts(keyboardHandlers));

    const activeThumbnail = screen.getByRole('option', { name: '0.jpg' });
    fireEvent.keyDown(activeThumbnail, { key: 'ArrowRight' });

    expect(useViewerStore.getState().currentIndex).toBe(1);
    expect(keyboardHandlers.goNext).not.toHaveBeenCalled();
  });

  it('recomputes the preload window when a mounted strip receives a new image list', () => {
    const firstImages = Array.from({ length: 100 }, (_, index) => ({
      path: `C:/first/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: '1',
    }));
    const nextImages = Array.from({ length: 100 }, (_, index) => ({
      path: `C:/next/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: '1',
    }));

    useViewerStore.setState({
      currentIndex: 80,
      currentImagePath: firstImages[80].path,
      images: firstImages,
    });

    render(<ThumbnailStrip />);
    preloadThumbnailsMock.mockClear();

    act(() => {
      useViewerStore.setState({
        currentIndex: 5,
        currentImagePath: nextImages[5].path,
        images: nextImages,
      });
    });

    const firstPreloadRequest = preloadThumbnailsMock.mock.calls[0]?.[0] as
      | Array<{ path: string }>
      | undefined;
    expect(firstPreloadRequest?.some((request) => request.path === nextImages[5].path)).toBe(true);
    expect(firstPreloadRequest?.some((request) => request.path === nextImages[80].path)).toBe(
      false
    );
  });

  it('coalesces wheel thumbnail browsing through animation frames', () => {
    const images = Array.from({ length: 100 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: '1',
    }));
    let frameCallback: FrameRequestCallback | null = null;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 7;
    });
    window.requestAnimationFrame = requestAnimationFrame as typeof window.requestAnimationFrame;

    useViewerStore.setState({
      currentIndex: 0,
      currentImagePath: images[0].path,
      images,
    });

    const { container } = render(<ThumbnailStrip />);
    const stripContainer = container.querySelector('.thumbnail-strip-container') as HTMLDivElement;
    preloadThumbnailsMock.mockClear();
    requestAnimationFrame.mockClear();

    fireEvent.wheel(stripContainer, { deltaY: 50 * 78 });
    fireEvent.wheel(stripContainer, { deltaY: 2 * 78 });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(preloadThumbnailsMock).not.toHaveBeenCalled();

    act(() => {
      frameCallback?.(0);
    });

    expect(preloadThumbnailsMock).toHaveBeenCalledTimes(1);
    expect(
      (preloadThumbnailsMock.mock.calls[0][0] as Array<{ path: string }>).some(
        (request) => request.path === images[52].path
      )
    ).toBe(true);
  });
});

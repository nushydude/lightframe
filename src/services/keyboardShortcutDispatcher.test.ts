import { describe, expect, it, vi } from 'vitest';
import {
  dispatchCropShortcut,
  dispatchViewerShortcut,
  type KeyboardHandlers,
  type ViewerShortcutContext,
} from './keyboardShortcutDispatcher';

function handlers(overrides: Partial<KeyboardHandlers> = {}): KeyboardHandlers {
  return {
    openFilePicker: vi.fn(),
    openCurrentImageInEditor: vi.fn(),
    copyCurrentImagePath: vi.fn(),
    goNext: vi.fn(() => true),
    goPrev: vi.fn(() => true),
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
    ...overrides,
  };
}

function viewerContext(
  shortcutHandlers: KeyboardHandlers,
  overrides: Partial<ViewerShortcutContext> = {}
): ViewerShortcutContext {
  return {
    viewMode: 'viewer',
    currentImagePath: 'C:/Images/a.jpg',
    isSlideshowActive: false,
    loopSlideshow: false,
    handlers: shortcutHandlers,
    resetZoom: vi.fn(),
    setZoomMode: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    ...overrides,
  };
}

describe('dispatchCropShortcut', () => {
  it('blocks viewer navigation while crop mode is waiting for a crop rectangle', () => {
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });

    expect(
      dispatchCropShortcut(event, {
        isCropMode: true,
        cropRect: null,
        updateCropRect: vi.fn(),
        applyCropPreview: vi.fn(),
        exitCropMode: vi.fn(),
      })
    ).toBe('blocked');
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('dispatchViewerShortcut', () => {
  it('dispatches viewer commands synchronously so browser defaults can be prevented', () => {
    const resetZoom = vi.fn();
    const event = new KeyboardEvent('keydown', { key: '0', cancelable: true });

    dispatchViewerShortcut(event, viewerContext(handlers(), { resetZoom }));

    expect(event.defaultPrevented).toBe(true);
    expect(resetZoom).toHaveBeenCalledTimes(1);
  });

  it('forwards the slideshow loop setting when navigating with an arrow key', async () => {
    const goNext = vi.fn(() => true);
    const shortcutHandlers = handlers({ goNext });
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });

    await dispatchViewerShortcut(event, viewerContext(shortcutHandlers, { loopSlideshow: true }));

    expect(event.defaultPrevented).toBe(true);
    expect(goNext).toHaveBeenCalledWith(true);
  });

  it('pauses an active slideshow instead of advancing on Space', async () => {
    const toggleSlideshowPause = vi.fn();
    const goNext = vi.fn(() => true);
    const shortcutHandlers = handlers({ goNext, toggleSlideshowPause });
    const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', cancelable: true });

    await dispatchViewerShortcut(
      event,
      viewerContext(shortcutHandlers, { isSlideshowActive: true })
    );

    expect(toggleSlideshowPause).toHaveBeenCalledTimes(1);
    expect(goNext).not.toHaveBeenCalled();
  });
});

import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import { initializeRuntime } from '../services/runtime/runtime';
import { createTestRuntimeAdapter } from '../services/runtime/testAdapter';

describe('useKeyboardShortcuts', () => {
  const handlers = {
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
  };

  beforeEach(() => {
    useViewerStore.getState().reset();
    vi.clearAllMocks();
    useViewerStore.setState({ currentImagePath: 'c:/test/a.jpg' });
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        loopSlideshow: false,
        persistedMarkedFolders: [],
      },
    }));
    document.body.innerHTML = '';
  });

  it('refreshes current folder on Ctrl+R and prevents browser reload', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: 'r',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.refreshFolder).toHaveBeenCalledTimes(1);
  });

  it('refreshes current folder on F6', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.refreshFolder).toHaveBeenCalledTimes(1);
  });

  it('opens command palette on Ctrl+K', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.openCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('opens settings on Ctrl+,', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: ',',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(useViewerStore.getState().showSettings).toBe(true);
  });

  it('toggles performance telemetry on Ctrl+Shift+F12', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: 'F12',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.togglePerformanceTelemetry).toHaveBeenCalledTimes(1);
  });

  it('routes the grid shortcut through the shared toggle handler', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.toggleGridView).toHaveBeenCalledTimes(1);
  });

  it('opens the configured external editor on Ctrl+E', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: 'e',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.openCurrentImageInEditor).toHaveBeenCalledTimes(1);
  });

  it('copies the current image path on Ctrl+Shift+C', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: 'C',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.copyCurrentImagePath).toHaveBeenCalledTimes(1);
  });

  it('deletes the current image on Delete', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.deleteCurrentImage).toHaveBeenCalledTimes(1);
  });

  it('does not delete from the shared handler while grid view is active', () => {
    useViewerStore.setState({ viewMode: 'grid' });
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(handlers.deleteCurrentImage).not.toHaveBeenCalled();
  });

  it('nudges crop rect and previews it with keyboard while crop mode is active', () => {
    const image = document.createElement('img');
    image.className = 'image-canvas';
    Object.defineProperty(image, 'naturalWidth', { value: 1000, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 500, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    useViewerStore.getState().enterCropMode();
    const before = useViewerStore.getState().cropRect!;

    renderHook(() => useKeyboardShortcuts(handlers));

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(useViewerStore.getState().cropRect!.x).toBeGreaterThan(before.x);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });

    expect(useViewerStore.getState().isCropMode).toBe(false);
    expect(useViewerStore.getState().pendingCropPreview).not.toBeNull();
  });

  it('toggles favorite with F and sets rating with Alt+number', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const favoriteEvent = new KeyboardEvent('keydown', {
      key: 'f',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(favoriteEvent);
    });
    expect(favoriteEvent.defaultPrevented).toBe(true);
    expect(handlers.toggleFavoriteCurrent).toHaveBeenCalledTimes(1);

    const ratingEvent = new KeyboardEvent('keydown', {
      key: '4',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(ratingEvent);
    });
    expect(ratingEvent.defaultPrevented).toBe(true);
    expect(handlers.setRatingCurrent).toHaveBeenCalledWith(4);
  });

  it('toggles the current mark with M', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', {
      key: 'm',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.toggleMarkedCurrent).toHaveBeenCalledTimes(1);
  });

  it('does not rerender shortcut handling when unrelated persisted mark settings change', () => {
    let renderCount = 0;

    renderHook(() => {
      renderCount++;
      useKeyboardShortcuts(handlers);
    });

    expect(renderCount).toBe(1);

    act(() => {
      useSettingsStore.setState((state) => ({
        settings: {
          ...state.settings,
          persistedMarkedFolders: [
            {
              folderPath: 'c:/images',
              markedPaths: ['c:/images/one.jpg'],
              updatedAt: 1,
            },
          ],
        },
      }));
    });

    expect(renderCount).toBe(1);
  });

  it('handles compare mode keyboard controls', () => {
    useViewerStore.setState({
      images: [
        {
          path: 'c:/test/a.jpg',
          file_name: 'a',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
        {
          path: 'c:/test/b.jpg',
          file_name: 'b',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
        {
          path: 'c:/test/c.jpg',
          file_name: 'c',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
      ],
      currentIndex: 1,
      currentImagePath: 'c:/test/b.jpg',
    });
    useViewerStore.getState().enterCompareMode();

    renderHook(() => useKeyboardShortcuts(handlers));

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      );
    });
    expect(useViewerStore.getState().compareFocusedPane).toBe('primary');

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
      );
    });
    expect(useViewerStore.getState().comparePrimaryIndex).toBe(0);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      );
    });
    expect(useViewerStore.getState().compareFocusedPane).toBe('secondary');

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
    expect(useViewerStore.getState().comparePrimaryIndex).toBe(2);
    expect(useViewerStore.getState().currentIndex).toBe(2);
    expect(useViewerStore.getState().compareSecondaryIndex).toBe(0);
    expect(useViewerStore.getState().compareFocusedPane).toBe('primary');

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(useViewerStore.getState().viewMode).toBe('viewer');
    expect(useViewerStore.getState().currentIndex).toBe(2);
  });

  it('closes the window when Escape is pressed twice without another higher-priority action', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    initializeRuntime(
      createTestRuntimeAdapter({
        window: { ...createTestRuntimeAdapter().window, close: closeSpy },
      })
    );

    renderHook(() => useKeyboardShortcuts(handlers));

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not close the window on the second Escape if the first one reset zoom', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    initializeRuntime(
      createTestRuntimeAdapter({
        window: { ...createTestRuntimeAdapter().window, close: closeSpy },
      })
    );
    useViewerStore.setState({ zoomMode: 'actual' });

    renderHook(() => useKeyboardShortcuts(handlers));

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });

    expect(useViewerStore.getState().zoomMode).toBe('fit');
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

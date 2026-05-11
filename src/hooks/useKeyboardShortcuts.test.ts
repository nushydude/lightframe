import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useViewerStore } from '../state/viewerStore';

describe('useKeyboardShortcuts', () => {
  const handlers = {
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
  };

  beforeEach(() => {
    useViewerStore.getState().reset();
    vi.clearAllMocks();
    useViewerStore.setState({ currentImagePath: 'c:/test/a.jpg' });
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
});

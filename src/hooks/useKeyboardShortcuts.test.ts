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
  };

  beforeEach(() => {
    useViewerStore.getState().reset();
    vi.clearAllMocks();
    useViewerStore.setState({ currentImagePath: 'c:/test/a.jpg' });
  });

  it('refreshes current folder on Ctrl+R and prevents browser reload', () => {
    renderHook(() => useKeyboardShortcuts(handlers));

    const event = new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true });
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
});

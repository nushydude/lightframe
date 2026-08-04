import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeWindow } from '../services/runtime/types';
import { useWindowPersistence } from './useWindowPersistence';

const boundsMocks = vi.hoisted(() => ({
  currentMonitor: vi.fn().mockResolvedValue(null),
  persistWindowBoundsSafely: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/windowBounds', () => ({
  displayKeyFromMonitor: vi.fn().mockReturnValue(null),
  persistWindowBoundsSafely: boundsMocks.persistWindowBoundsSafely,
}));

describe('useWindowPersistence', () => {
  it('attaches and removes both native window listeners for the main window', async () => {
    const unlistenMoved = vi.fn();
    const unlistenResized = vi.fn();
    const appWindow = {
      onMoved: vi.fn().mockResolvedValue(unlistenMoved),
      onResized: vi.fn().mockResolvedValue(unlistenResized),
      isFullscreen: vi.fn().mockResolvedValue(false),
      isMinimized: vi.fn().mockResolvedValue(false),
      outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
      innerSize: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
    } as unknown as RuntimeWindow;

    const { unmount } = renderHook(() =>
      useWindowPersistence({
        appWindow,
        isMainWindow: true,
        settingsRef: { current: { rememberWindowBounds: true } } as never,
        settingsLoadedRef: { current: true },
        updateSettings: vi.fn().mockResolvedValue(true),
      })
    );

    expect(appWindow.onMoved).toHaveBeenCalledTimes(1);
    expect(appWindow.onResized).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    unmount();
    expect(unlistenMoved).toHaveBeenCalledTimes(1);
    expect(unlistenResized).toHaveBeenCalledTimes(1);
  });
});

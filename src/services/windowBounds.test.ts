import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../types/settings';
import {
  displayKeyFromMonitor,
  hasCompleteWindowBounds,
  persistWindowBoundsSafely,
  shouldPersistWindowBounds,
  windowBoundsForDisplay,
} from './windowBounds';

describe('hasCompleteWindowBounds', () => {
  it('returns true when all bounds are finite numbers', () => {
    expect(
      hasCompleteWindowBounds({
        windowX: 100,
        windowY: 200,
        windowWidth: 1200,
        windowHeight: 800,
      })
    ).toBe(true);
  });

  it('returns false when any bounds value is missing', () => {
    expect(
      hasCompleteWindowBounds({
        windowX: 100,
        windowY: 200,
        windowWidth: 1200,
      })
    ).toBe(false);
  });
});

describe('shouldPersistWindowBounds', () => {
  it('returns true for main window when remember is enabled and window is normal', () => {
    expect(
      shouldPersistWindowBounds({
        settings: { ...DEFAULT_SETTINGS, rememberWindowBounds: true },
        isMainWindow: true,
        isFullscreen: false,
        isMinimized: false,
      })
    ).toBe(true);
  });

  it('returns false when remember is disabled', () => {
    expect(
      shouldPersistWindowBounds({
        settings: { ...DEFAULT_SETTINGS, rememberWindowBounds: false },
        isMainWindow: true,
        isFullscreen: false,
        isMinimized: false,
      })
    ).toBe(false);
  });

  it('returns false for non-main windows', () => {
    expect(
      shouldPersistWindowBounds({
        settings: { ...DEFAULT_SETTINGS, rememberWindowBounds: true },
        isMainWindow: false,
        isFullscreen: false,
        isMinimized: false,
      })
    ).toBe(false);
  });

  it('returns false while fullscreen or minimized', () => {
    expect(
      shouldPersistWindowBounds({
        settings: { ...DEFAULT_SETTINGS, rememberWindowBounds: true },
        isMainWindow: true,
        isFullscreen: true,
        isMinimized: false,
      })
    ).toBe(false);

    expect(
      shouldPersistWindowBounds({
        settings: { ...DEFAULT_SETTINGS, rememberWindowBounds: true },
        isMainWindow: true,
        isFullscreen: false,
        isMinimized: true,
      })
    ).toBe(false);
  });
});

describe('persistWindowBoundsSafely', () => {
  const baseSettings = {
    ...DEFAULT_SETTINGS,
    rememberWindowBounds: true,
  };

  it('does not call updateSettings if unmounted after flag read resolves', async () => {
    let isUnmounted = false;
    let resolveFlags!: (value: { isFullscreen: boolean; isMinimized: boolean }) => void;
    const flagsPromise = new Promise<{ isFullscreen: boolean; isMinimized: boolean }>((resolve) => {
      resolveFlags = resolve;
    });
    const updateSettings = vi.fn(async () => {});

    const persistPromise = persistWindowBoundsSafely({
      isUnmounted: () => isUnmounted,
      isSettingsLoaded: true,
      isMainWindow: true,
      settings: baseSettings,
      readWindowFlags: () => flagsPromise,
      readWindowBounds: async () => ({
        position: { x: 100, y: 100 },
        size: { width: 1280, height: 720 },
      }),
      updateSettings,
    });

    isUnmounted = true;
    resolveFlags({ isFullscreen: false, isMinimized: false });
    await persistPromise;

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('does not call updateSettings if unmounted after bounds read resolves', async () => {
    let isUnmounted = false;
    let resolveBounds!: (value: {
      position: { x: number; y: number };
      size: { width: number; height: number };
    }) => void;
    const boundsPromise = new Promise<{
      position: { x: number; y: number };
      size: { width: number; height: number };
    }>((resolve) => {
      resolveBounds = resolve;
    });
    const updateSettings = vi.fn(async () => {});

    const persistPromise = persistWindowBoundsSafely({
      isUnmounted: () => isUnmounted,
      isSettingsLoaded: true,
      isMainWindow: true,
      settings: baseSettings,
      readWindowFlags: async () => ({ isFullscreen: false, isMinimized: false }),
      readWindowBounds: () => boundsPromise,
      updateSettings,
    });

    isUnmounted = true;
    resolveBounds({
      position: { x: 200, y: 150 },
      size: { width: 1366, height: 768 },
    });
    await persistPromise;

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('persists display-specific bounds alongside legacy bounds', async () => {
    const updateSettings = vi.fn(async () => {});

    await persistWindowBoundsSafely({
      isUnmounted: () => false,
      isSettingsLoaded: true,
      isMainWindow: true,
      settings: baseSettings,
      readWindowFlags: async () => ({ isFullscreen: false, isMinimized: false }),
      readWindowBounds: async () => ({
        position: { x: 10, y: 20 },
        size: { width: 1440, height: 900 },
      }),
      readDisplayKey: async () => 'display:0:0:3440x1440@1',
      updateSettings,
    });

    expect(updateSettings).toHaveBeenCalledWith({
      windowX: 10,
      windowY: 20,
      windowWidth: 1440,
      windowHeight: 900,
      lastWindowDisplayKey: 'display:0:0:3440x1440@1',
      windowBoundsByDisplay: {
        'display:0:0:3440x1440@1': { x: 10, y: 20, width: 1440, height: 900 },
      },
    });
  });
});

describe('displayKeyFromMonitor', () => {
  it('creates stable keys from monitor geometry', () => {
    expect(
      displayKeyFromMonitor({
        name: 'Portrait',
        position: { x: 1920, y: 0 },
        size: { width: 1080, height: 1920 },
        scaleFactor: 1.25,
      })
    ).toBe('Portrait|1920,0|1080x1920|scale-1.25');
  });

  it('returns null without a monitor', () => {
    expect(displayKeyFromMonitor(null)).toBeNull();
  });
});

describe('windowBoundsForDisplay', () => {
  it('prefers display-specific bounds and uses legacy bounds for first migration', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      windowX: 1,
      windowY: 2,
      windowWidth: 3,
      windowHeight: 4,
      windowBoundsByDisplay: {},
    };

    expect(windowBoundsForDisplay(settings, 'primary')).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it('prefers the last active display when it is still available', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      lastWindowDisplayKey: 'secondary',
      windowBoundsByDisplay: {
        primary: { x: 10, y: 20, width: 1440, height: 900 },
        secondary: { x: 1600, y: 50, width: 1200, height: 800 },
      },
    };

    expect(windowBoundsForDisplay(settings, 'primary', ['primary', 'secondary'])).toEqual({
      x: 1600,
      y: 50,
      width: 1200,
      height: 800,
    });
  });

  it('falls back to the startup display when the last active display is unavailable', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      lastWindowDisplayKey: 'secondary',
      windowBoundsByDisplay: {
        primary: { x: 10, y: 20, width: 1440, height: 900 },
        secondary: { x: 1600, y: 50, width: 1200, height: 800 },
      },
    };

    expect(windowBoundsForDisplay(settings, 'primary', ['primary'])).toEqual({
      x: 10,
      y: 20,
      width: 1440,
      height: 900,
    });
  });

  it('falls back to legacy bounds when the current display key does not match', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      windowX: 1,
      windowY: 2,
      windowWidth: 3,
      windowHeight: 4,
      windowBoundsByDisplay: {
        primary: { x: 10, y: 20, width: 1440, height: 900 },
      },
    };

    expect(windowBoundsForDisplay(settings, 'primary')).toEqual({
      x: 10,
      y: 20,
      width: 1440,
      height: 900,
    });
    expect(windowBoundsForDisplay(settings, 'secondary')).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(windowBoundsForDisplay(settings, null)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('does not restore stale legacy bounds when display-specific entries already exist', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      windowX: 1,
      windowY: 2,
      windowWidth: 3,
      windowHeight: 4,
      lastWindowDisplayKey: 'secondary',
      windowBoundsByDisplay: {
        primary: { x: 10, y: 20, width: 1440, height: 900 },
        secondary: { x: 1600, y: 50, width: 1200, height: 800 },
      },
    };

    expect(windowBoundsForDisplay(settings, 'unknown', ['primary'])).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../types/settings';
import { displayKeyFromMonitor } from './windowBounds';
import { restoreMainWindowBounds } from './mainWindowRestore';

const monitor = {
  name: 'Primary',
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: {
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1040 },
  },
  scaleFactor: 1,
};

function restoreSettings() {
  const displayKey = displayKeyFromMonitor(monitor);
  if (!displayKey) throw new Error('Expected a display key');
  return {
    ...DEFAULT_SETTINGS,
    rememberWindowBounds: true,
    lastWindowDisplayKey: displayKey,
    windowBoundsByDisplay: {
      [displayKey]: { x: 100, y: 120, width: 1000, height: 700 },
    },
  };
}

describe('restoreMainWindowBounds', () => {
  it('restores size before position from the active display bounds', async () => {
    const calls: string[] = [];
    const setSize = vi.fn(async (size: { width: number; height: number }) => {
      calls.push(`size:${size.width}x${size.height}`);
    });
    const setPosition = vi.fn(async (position: { x: number; y: number }) => {
      calls.push(`position:${position.x},${position.y}`);
    });

    await restoreMainWindowBounds({ setSize, setPosition }, restoreSettings(), () => true, {
      current: async () => monitor,
      available: async () => [monitor],
    });

    expect(calls).toEqual(['size:1000x700', 'position:100,120']);
  });

  it('does not move a window after restore is cancelled during resizing', async () => {
    let canContinue = true;
    const setSize = vi.fn(async () => {
      canContinue = false;
    });
    const setPosition = vi.fn(async () => {});

    await restoreMainWindowBounds({ setSize, setPosition }, restoreSettings(), () => canContinue, {
      current: async () => monitor,
      available: async () => [monitor],
    });

    expect(setSize).toHaveBeenCalledTimes(1);
    expect(setPosition).not.toHaveBeenCalled();
  });
});

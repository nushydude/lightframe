import { describe, expect, it, vi } from 'vitest';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import {
  createTauriWindowAdapter,
  projectorWindowOptions,
  selectProjectorMonitor,
  waitForProjectorCreation,
} from './tauriRuntimeAdapter';
import { projectorWindowTitle } from '../windowTitle';

it('uses the versioned projector title for newly created windows', () => {
  expect(projectorWindowOptions().title).toBe(projectorWindowTitle());
});

const monitor = (name: string | null, x: number, y: number, width: number, height: number) => ({
  name,
  position: { x, y },
  size: { width, height },
});

describe('selectProjectorMonitor', () => {
  it('returns the only monitor when one is available', () => {
    const only = monitor(null, 0, 0, 1920, 1080);
    expect(selectProjectorMonitor([only], only)).toBe(only);
  });

  it('selects a distinct monitor using full identity instead of name alone', () => {
    const active = monitor('Display', 0, 0, 1920, 1080);
    const secondary = monitor('Display', 1920, 0, 1920, 1080);
    expect(selectProjectorMonitor([active, secondary], active)).toBe(secondary);
  });

  it('handles unnamed displays by their position and size', () => {
    const active = monitor(null, 0, 0, 1920, 1080);
    const secondary = monitor(null, -1280, 0, 1280, 1024);
    expect(selectProjectorMonitor([active, secondary], active)).toBe(secondary);
  });
});

describe('tauri runtime window seam', () => {
  it('converts structural bounds to PhysicalPosition and PhysicalSize before forwarding', async () => {
    const setPosition = vi
      .fn<(position: PhysicalPosition) => Promise<void>>()
      .mockResolvedValue(undefined);
    const setSize = vi.fn<(size: PhysicalSize) => Promise<void>>().mockResolvedValue(undefined);
    const native = {
      label: 'main',
      show: async () => undefined,
      setTitle: async () => undefined,
      setFullscreen: async () => undefined,
      isFullscreen: async () => false,
      isMinimized: async () => false,
      outerPosition: async () => ({ x: 0, y: 0 }),
      innerSize: async () => ({ width: 1, height: 1 }),
      setPosition,
      setSize,
      onMoved: async () => () => undefined,
      onResized: async () => () => undefined,
      close: async () => undefined,
    };
    const physicalPosition = vi.fn(
      (value: { x: number; y: number }) => new PhysicalPosition(value.x, value.y)
    );
    const physicalSize = vi.fn(
      (value: { width: number; height: number }) => new PhysicalSize(value.width, value.height)
    );
    const runtimeWindow = createTauriWindowAdapter(native, {
      position: physicalPosition,
      size: physicalSize,
    });

    await runtimeWindow.setPosition({ x: 100, y: 200 });
    await runtimeWindow.setSize({ width: 1200, height: 800 });

    expect(physicalPosition).toHaveBeenCalledWith({ x: 100, y: 200 });
    expect(physicalSize).toHaveBeenCalledWith({ width: 1200, height: 800 });
    expect(setPosition.mock.calls[0]?.[0]).toBeInstanceOf(PhysicalPosition);
    expect(setSize.mock.calls[0]?.[0]).toBeInstanceOf(PhysicalSize);
  });
});

describe('waitForProjectorCreation', () => {
  it('waits for the created event and rejects on the error event', async () => {
    const handlers = new Map<string, (event: { payload?: unknown }) => void>();
    const once = vi.fn(async (event: string, handler: (payload: { payload?: unknown }) => void) => {
      handlers.set(event, handler);
    });
    const waiting = waitForProjectorCreation({ once });
    expect(once).toHaveBeenCalledWith('tauri://created', expect.any(Function));
    expect(once).toHaveBeenCalledWith('tauri://error', expect.any(Function));
    handlers.get('tauri://created')?.({});
    await expect(waiting).resolves.toBeUndefined();

    const rejected = waitForProjectorCreation({ once });
    handlers.get('tauri://error')?.({ payload: 'creation failed' });
    await expect(rejected).rejects.toThrow('creation failed');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import { createBrowserDevelopmentAdapter } from './browserDevelopmentAdapter';
import {
  detectBrowserDevelopmentRuntime,
  initializeRuntime,
  resetRuntimeForTests,
} from './runtime';
import { createTestRuntimeAdapter } from './testAdapter';

afterEach(resetRuntimeForTests);

describe('runtime boundary', () => {
  it('detects a browser development surface without probing Tauri APIs', () => {
    expect(detectBrowserDevelopmentRuntime()).toBe(true);
  });

  it('keeps browser privileged operations unavailable', async () => {
    const runtime = createBrowserDevelopmentAdapter();
    await expect(runtime.unsupported('filesystem access')).rejects.toThrow('pnpm tauri dev');
    expect(await runtime.openFolder()).toBeNull();
    expect(runtime.assetUrl('C:/private.jpg')).toBe('');
  });

  it('cleans up asynchronous listeners safely', async () => {
    const runtime = createBrowserDevelopmentAdapter();
    const listener = vi.fn();
    const unlisten = await runtime.listen('event', listener);
    unlisten();
    await runtime.emit('event', { value: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps listeners isolated between browser adapter instances', async () => {
    const first = createBrowserDevelopmentAdapter();
    const second = createBrowserDevelopmentAdapter();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    await first.listen('isolated', firstListener);
    await second.listen('isolated', secondListener);
    await first.emit('isolated', 'first');
    expect(firstListener).toHaveBeenCalledWith('first');
    expect(secondListener).not.toHaveBeenCalled();
  });

  it('denies browser privileged capabilities without exposing native behavior', async () => {
    const runtime = createBrowserDevelopmentAdapter();
    await expect(runtime.relaunch()).rejects.toThrow('pnpm tauri dev');
    await expect(runtime.revealItem('C:/private.jpg')).rejects.toThrow('pnpm tauri dev');
    await expect(runtime.openExternal('https://example.com')).rejects.toThrow('pnpm tauri dev');
    await expect(runtime.openSecondaryWindow()).rejects.toThrow('pnpm tauri dev');
    await expect(runtime.window.setFullscreen(true)).rejects.toThrow('pnpm tauri dev');
    await expect(runtime.checkUpdateChannel('stable')).resolves.toBeNull();
    await expect(runtime.openFileOrFolder()).resolves.toBeNull();
    await expect(runtime.openFolder()).resolves.toBeNull();
    await expect(runtime.saveFile()).resolves.toBeNull();
    expect(runtime.assetUrl('C:/private.jpg')).toBe('');
  });

  it('accepts injected test adapters', () => {
    const runtime = createTestRuntimeAdapter({ kind: 'browser-development' });
    expect(initializeRuntime(runtime)).toBe(runtime);
  });

  it('resets the initialized adapter between tests', () => {
    const injected = createTestRuntimeAdapter();
    initializeRuntime(injected);
    resetRuntimeForTests();
    expect(initializeRuntime()).not.toBe(injected);
  });

  it('cleans a delayed listener registration when an effect unmounts', async () => {
    let resolve!: (value: () => void) => void;
    const cleanup = vi.fn();
    const listen = vi.fn(() => new Promise<() => void>((done) => (resolve = done)));
    const runtime = createTestRuntimeAdapter({ listen });
    const { unmount } = renderHook(() => {
      useEffect(() => {
        let cancelled = false;
        void runtime
          .listen('delayed', () => undefined)
          .then((unlisten) => {
            if (cancelled) unlisten();
          });
        return () => {
          cancelled = true;
        };
      }, []);
    });
    unmount();
    resolve(cleanup);
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

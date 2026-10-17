import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { configureNativeMedia, invokeNativeMedia, nativeMediaPriority } from './nativeMedia';
import { createImageWorkScheduler } from './imageWorkScheduler';
import { getPerformanceModeProfile } from './performanceMode';

describe('native media requests', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('cancels obsolete native generations and rejects late results while retaining physical capacity', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === 'get_preview_image'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(undefined)
    );
    const scheduler = createImageWorkScheduler({ maxConcurrent: 1 });
    const controller = new AbortController();
    const handle = scheduler.schedule({
      key: 'old',
      sourcePath: 'private-path',
      priority: 'current-preview',
      generationToken: 17,
      signal: controller.signal,
      run: (context) =>
        invokeNativeMedia('get_preview_image', { filePath: 'private-path' }, context),
    });
    const request = (vi.mocked(invoke).mock.calls[0]?.[1] as Record<string, unknown>)?.request;
    expect(request).toEqual({
      requestId: expect.any(String),
      generationToken: '17',
      priority: 'current-preview',
    });
    expect(JSON.stringify(request)).not.toContain('private-path');
    controller.abort();
    await expect(handle.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('cancel_media_request', {
      requestId: (request as { requestId: string }).requestId,
    });
    expect(scheduler.getSnapshot().inFlight).toBe(1);
    finish('stale');
    await vi.waitFor(() => expect(scheduler.getSnapshot().inFlight).toBe(0));
  });

  it('keeps shared native work alive until the last scheduler consumer cancels', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const scheduler = createImageWorkScheduler();
    const options = {
      key: 'shared',
      sourcePath: 'a',
      priority: 'current-preview' as const,
      run: (context: { signal: AbortSignal }) =>
        invokeNativeMedia('get_preview_image', {}, context),
    };
    const first = scheduler.schedule(options);
    const second = scheduler.schedule(options);
    first.cancel();
    await expect(first.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledTimes(1);
    finish('valid');
    await expect(second.promise).resolves.toBe('valid');
  });

  it('rejects late native results after cancellation and removes listeners on settlement', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === 'media'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(undefined)
    );
    const controller = new AbortController();
    const pending = invokeNativeMedia('media', {}, { signal: controller.signal });
    controller.abort();
    finish('stale');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const alreadyAborted = invokeNativeMedia('media', {}, { signal: controller.signal });
    await expect(alreadyAborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledTimes(2);
    const completedController = new AbortController();
    const completed = invokeNativeMedia('media', {}, { signal: completedController.signal });
    finish('valid');
    await expect(completed).resolves.toBe('valid');
    completedController.abort();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('maps frontend priorities and clamps every performance mode to native ceilings', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    expect(nativeMediaPriority('foreground-thumbnail')).toBe('visible-thumbnail');
    expect(nativeMediaPriority('adjacent-directional')).toBe('adjacent-directional');
    for (const mode of ['fast', 'balanced', 'lowMemory'] as const) {
      await configureNativeMedia(getPerformanceModeProfile(mode).nativeMediaCapacity);
    }
    await configureNativeMedia(99);
    await configureNativeMedia(-1);
    await configureNativeMedia(NaN);
    expect(vi.mocked(invoke).mock.calls.map((call) => call[1])).toEqual([
      { capacity: 4 },
      { capacity: 3 },
      { capacity: 2 },
      { capacity: 4 },
      { capacity: 2 },
      { capacity: 2 },
    ]);
  });

  it('normalizes native cancellation rejection to AbortError', async () => {
    let reject!: (reason: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === 'media'
        ? new Promise((_, fail) => {
            reject = fail;
          })
        : Promise.resolve(undefined)
    );
    const controller = new AbortController();
    const pending = invokeNativeMedia('media', {}, { signal: controller.signal });
    controller.abort();
    reject('Media request canceled');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

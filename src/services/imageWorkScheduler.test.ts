import { beforeEach, describe, expect, it } from 'vitest';
import {
  createImageWorkScheduler,
  IMAGE_WORK_PRIORITY,
  type ImageWorkPriority,
} from './imageWorkScheduler';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('imageWorkScheduler', () => {
  beforeEach(async () => {
    const { resetPerformanceTelemetryForTests } = await import('./performanceTelemetry');
    resetPerformanceTelemetryForTests();
  });

  it('runs queued work in priority order after an active task completes', async () => {
    const scheduler = createImageWorkScheduler({
      maxConcurrent: 1,
      maxInteractiveConcurrent: 1,
      maxVisibleConcurrent: 1,
      maxBackgroundConcurrent: 1,
    });
    const blocker = createDeferred<void>();
    const started: string[] = [];

    scheduler.schedule({
      key: 'blocker',
      priority: IMAGE_WORK_PRIORITY.currentMetadata,
      sourcePath: 'C:/images/blocker.jpg',
      run: async () => {
        started.push('blocker');
        await blocker.promise;
        return 'blocker';
      },
    });

    const scheduleTask = (key: string, priority: ImageWorkPriority) =>
      scheduler.schedule({
        key,
        priority,
        sourcePath: `C:/images/${key}.jpg`,
        run: async () => {
          started.push(key);
          return key;
        },
      }).promise;

    const backgroundPromise = scheduleTask('background', IMAGE_WORK_PRIORITY.backgroundPreload);
    const visiblePromise = scheduleTask('visible', IMAGE_WORK_PRIORITY.visibleThumbnail);
    const currentPromise = scheduleTask('current', IMAGE_WORK_PRIORITY.currentPreview);

    blocker.resolve();
    await expect(currentPromise).resolves.toBe('current');
    await expect(visiblePromise).resolves.toBe('visible');
    await expect(backgroundPromise).resolves.toBe('background');
    expect(started).toEqual(['blocker', 'current', 'visible', 'background']);
  });

  it('deduplicates work by key and promotes queued priority when a stronger request arrives', async () => {
    const scheduler = createImageWorkScheduler({
      maxConcurrent: 1,
      maxInteractiveConcurrent: 1,
      maxVisibleConcurrent: 1,
      maxBackgroundConcurrent: 1,
    });
    const blocker = createDeferred<void>();
    let runCount = 0;
    const started: string[] = [];

    scheduler.schedule({
      key: 'blocker',
      priority: IMAGE_WORK_PRIORITY.currentMetadata,
      sourcePath: 'C:/images/blocker.jpg',
      run: async () => {
        started.push('blocker');
        await blocker.promise;
        return 'blocker';
      },
    });

    const first = scheduler.schedule({
      key: 'shared',
      priority: IMAGE_WORK_PRIORITY.backgroundPreload,
      sourcePath: 'C:/images/shared.jpg',
      run: async () => {
        runCount += 1;
        started.push('shared');
        return 'shared';
      },
    });
    const second = scheduler.schedule({
      key: 'shared',
      priority: IMAGE_WORK_PRIORITY.currentPreview,
      sourcePath: 'C:/images/shared.jpg',
      run: async () => 'should-not-run',
    });
    const visible = scheduler.schedule({
      key: 'visible',
      priority: IMAGE_WORK_PRIORITY.visibleThumbnail,
      sourcePath: 'C:/images/visible.jpg',
      run: async () => {
        started.push('visible');
        return 'visible';
      },
    });

    blocker.resolve();

    await expect(first.promise).resolves.toBe('shared');
    await expect(second.promise).resolves.toBe('shared');
    await expect(visible.promise).resolves.toBe('visible');
    expect(runCount).toBe(1);
    expect(started).toEqual(['blocker', 'shared', 'visible']);
  });

  it('keeps foreground thumbnail capacity separate from current-image work', async () => {
    const scheduler = createImageWorkScheduler({
      maxConcurrent: 4,
      maxInteractiveConcurrent: 1,
      maxForegroundConcurrent: 2,
      maxVisibleConcurrent: 1,
      maxBackgroundConcurrent: 1,
    });
    const firstForeground = createDeferred<string>();
    const secondForeground = createDeferred<string>();
    const started: string[] = [];

    const foregroundA = scheduler.schedule({
      key: 'foreground-a',
      priority: IMAGE_WORK_PRIORITY.foregroundThumbnail,
      sourcePath: 'C:/images/a.jpg',
      run: async () => {
        started.push('foreground-a');
        return firstForeground.promise;
      },
    });
    const foregroundB = scheduler.schedule({
      key: 'foreground-b',
      priority: IMAGE_WORK_PRIORITY.foregroundThumbnail,
      sourcePath: 'C:/images/b.jpg',
      run: async () => {
        started.push('foreground-b');
        return secondForeground.promise;
      },
    });

    const current = scheduler.schedule({
      key: 'current-preview',
      priority: IMAGE_WORK_PRIORITY.currentPreview,
      sourcePath: 'C:/images/current.jpg',
      run: async () => {
        started.push('current-preview');
        return 'current-preview';
      },
    });

    expect(scheduler.getSnapshot()).toMatchObject({
      inFlight: 3,
      activeByPriority: {
        [IMAGE_WORK_PRIORITY.foregroundThumbnail]: 2,
        [IMAGE_WORK_PRIORITY.currentPreview]: 1,
      },
    });
    await expect(current.promise).resolves.toBe('current-preview');
    expect(started).toEqual(['foreground-a', 'foreground-b', 'current-preview']);

    firstForeground.resolve('foreground-a');
    secondForeground.resolve('foreground-b');
    await expect(foregroundA.promise).resolves.toBe('foreground-a');
    await expect(foregroundB.promise).resolves.toBe('foreground-b');
  });

  it('drops queued stale work before execution and reports it in the snapshot', async () => {
    const scheduler = createImageWorkScheduler({
      maxConcurrent: 1,
      maxInteractiveConcurrent: 1,
      maxVisibleConcurrent: 1,
      maxBackgroundConcurrent: 1,
    });
    const blocker = createDeferred<void>();
    let staleRan = false;

    scheduler.schedule({
      key: 'blocker',
      priority: IMAGE_WORK_PRIORITY.currentMetadata,
      sourcePath: 'C:/images/blocker.jpg',
      run: async () => {
        await blocker.promise;
        return 'blocker';
      },
    });

    const staleWork = scheduler.schedule({
      key: 'stale',
      priority: IMAGE_WORK_PRIORITY.visibleThumbnail,
      sourcePath: 'C:/images/stale.jpg',
      run: async () => {
        staleRan = true;
        return 'stale';
      },
    });

    expect(scheduler.getSnapshot().queueDepth).toBe(1);

    expect(
      scheduler.cancelQueued(
        (task: { sourcePath: string }) => task.sourcePath === 'C:/images/stale.jpg'
      )
    ).toBe(1);

    blocker.resolve();

    await expect(staleWork.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(staleRan).toBe(false);
    expect(scheduler.getSnapshot().droppedQueued).toBe(1);
    expect(scheduler.getSnapshot().queueDepth).toBe(0);
  });

  it('keeps a physical slot occupied until non-cooperative running work settles', async () => {
    const scheduler = createImageWorkScheduler({
      maxConcurrent: 1,
      maxInteractiveConcurrent: 1,
      maxVisibleConcurrent: 1,
      maxBackgroundConcurrent: 1,
    });
    const staleBlocker = createDeferred<string>();
    const abortController = new AbortController();
    const started: string[] = [];
    let staleAbortObserved = false;

    const staleWork = scheduler.schedule({
      key: 'stale',
      priority: IMAGE_WORK_PRIORITY.currentFull,
      sourcePath: 'C:/images/stale.jpg',
      signal: abortController.signal,
      run: async ({ signal }) => {
        signal.addEventListener('abort', () => {
          staleAbortObserved = true;
        });
        started.push('stale');
        return staleBlocker.promise;
      },
    });

    const freshWork = scheduler.schedule({
      key: 'fresh',
      priority: IMAGE_WORK_PRIORITY.currentFull,
      sourcePath: 'C:/images/fresh.jpg',
      run: async () => {
        started.push('fresh');
        return 'fresh';
      },
    });

    expect(started).toEqual(['stale']);

    abortController.abort();

    await expect(staleWork.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.getSnapshot()).toMatchObject({ inFlight: 1, canceledInFlight: 1 });
    expect(started).toEqual(['stale']);

    staleBlocker.resolve('stale');
    await expect(freshWork.promise).resolves.toBe('fresh');
    expect(staleAbortObserved).toBe(true);
    expect(started).toEqual(['stale', 'fresh']);
    expect(scheduler.getSnapshot()).toMatchObject({ inFlight: 0, canceledInFlight: 0 });
  });

  it('allows a replacement key while retaining tombstone capacity accounting', async () => {
    const scheduler = createImageWorkScheduler({ maxConcurrent: 1 });
    const oldWork = createDeferred<string>();
    const started: string[] = [];
    const oldController = new AbortController();
    const old = scheduler.schedule({
      key: 'same',
      priority: IMAGE_WORK_PRIORITY.currentFull,
      sourcePath: 'C:/images/same.jpg',
      signal: oldController.signal,
      run: async () => {
        started.push('old');
        return oldWork.promise;
      },
    });
    oldController.abort();
    await expect(old.promise).rejects.toMatchObject({ name: 'AbortError' });

    const replacement = scheduler.schedule({
      key: 'same',
      priority: IMAGE_WORK_PRIORITY.currentFull,
      sourcePath: 'C:/images/same.jpg',
      run: async () => {
        started.push('replacement');
        return 'replacement';
      },
    });

    // The replacement is deduplicated separately but cannot start while the tombstone runs.
    expect(started).toEqual(['old']);
    expect(scheduler.getSnapshot()).toMatchObject({ inFlight: 1, canceledInFlight: 1 });
    oldWork.resolve('old');
    await expect(replacement.promise).resolves.toBe('replacement');
    expect(started).toEqual(['old', 'replacement']);
  });

  it('releases capacity after a cooperative abort settles the worker promise', async () => {
    const scheduler = createImageWorkScheduler({ maxConcurrent: 1 });
    const controller = new AbortController();
    const started: string[] = [];
    const work = scheduler.schedule({
      key: 'cooperative',
      priority: IMAGE_WORK_PRIORITY.currentFull,
      sourcePath: 'C:/images/cooperative.jpg',
      signal: controller.signal,
      run: ({ signal }) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cooperative abort')));
          started.push('cooperative');
        }),
    });
    const replacement = scheduler.schedule({
      key: 'replacement',
      priority: IMAGE_WORK_PRIORITY.currentFull,
      sourcePath: 'C:/images/replacement.jpg',
      run: async () => {
        started.push('replacement');
        return 'replacement';
      },
    });

    controller.abort();
    await expect(work.promise).rejects.toMatchObject({ name: 'AbortError' });
    await expect(replacement.promise).resolves.toBe('replacement');
    expect(started).toEqual(['cooperative', 'replacement']);
  });
});

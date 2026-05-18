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

  it('frees an interactive slot when running work loses its last consumer', async () => {
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
    await expect(freshWork.promise).resolves.toBe('fresh');
    expect(staleAbortObserved).toBe(true);
    expect(started).toEqual(['stale', 'fresh']);

    staleBlocker.resolve('stale');
  });
});

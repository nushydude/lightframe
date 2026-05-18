import {
  setImageWorkActiveBackgroundTelemetry,
  setImageWorkActiveCountTelemetry,
  setImageWorkActiveInteractiveTelemetry,
  setImageWorkActiveVisibleTelemetry,
  setImageWorkDroppedQueuedTelemetry,
  setImageWorkQueueDepthTelemetry,
  setThumbnailInFlightTelemetry,
  setThumbnailQueueDepthTelemetry,
} from './performanceTelemetry';

export const IMAGE_WORK_PRIORITY = {
  currentPreview: 'current-preview',
  currentMetadata: 'current-metadata',
  currentFull: 'current-full',
  visibleThumbnail: 'visible-thumbnail',
  adjacentDirectional: 'adjacent-directional',
  backgroundPreload: 'background-preload',
} as const;

export type ImageWorkPriority = (typeof IMAGE_WORK_PRIORITY)[keyof typeof IMAGE_WORK_PRIORITY];

type ImageWorkHandle<T> = {
  key: string;
  promise: Promise<T>;
  cancel: () => void;
};

type ImageWorkTaskView = {
  key: string;
  sourcePath: string;
  priority: ImageWorkPriority;
  state: 'queued' | 'running';
};

type ImageWorkSnapshot = {
  queueDepth: number;
  inFlight: number;
  droppedQueued: number;
  activeByPriority: Record<ImageWorkPriority, number>;
  queuedByPriority: Record<ImageWorkPriority, number>;
};

type ImageWorkBucket = 'interactive' | 'visible' | 'background';
type ImageWorkListener = () => void;

type ImageWorkConsumer<T> = {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  canceled: boolean;
};

type ImageWorkJob<T> = {
  key: string;
  sourcePath: string;
  priority: ImageWorkPriority;
  state: 'queued' | 'running';
  sequence: number;
  settled: boolean;
  run: (context: { signal: AbortSignal }) => Promise<T>;
  controller: AbortController;
  consumers: Map<number, ImageWorkConsumer<T>>;
};

type ScheduleOptions<T> = {
  key: string;
  priority: ImageWorkPriority;
  sourcePath: string;
  generationToken?: number | string;
  signal?: AbortSignal;
  run: (context: { signal: AbortSignal }) => Promise<T> | T;
};

type SchedulerOptions = {
  maxConcurrent?: number;
  maxInteractiveConcurrent?: number;
  maxVisibleConcurrent?: number;
  maxBackgroundConcurrent?: number;
  onSnapshot?: (snapshot: ImageWorkSnapshot) => void;
};

function createAbortError(message = 'Image work canceled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function priorityBucket(priority: ImageWorkPriority): ImageWorkBucket {
  switch (priority) {
    case IMAGE_WORK_PRIORITY.currentPreview:
    case IMAGE_WORK_PRIORITY.currentMetadata:
    case IMAGE_WORK_PRIORITY.currentFull:
      return 'interactive';
    case IMAGE_WORK_PRIORITY.visibleThumbnail:
      return 'visible';
    default:
      return 'background';
  }
}

function createPrioritySnapshot(): Record<ImageWorkPriority, number> {
  return {
    [IMAGE_WORK_PRIORITY.currentPreview]: 0,
    [IMAGE_WORK_PRIORITY.currentMetadata]: 0,
    [IMAGE_WORK_PRIORITY.currentFull]: 0,
    [IMAGE_WORK_PRIORITY.visibleThumbnail]: 0,
    [IMAGE_WORK_PRIORITY.adjacentDirectional]: 0,
    [IMAGE_WORK_PRIORITY.backgroundPreload]: 0,
  };
}

function compareJobs(left: ImageWorkJob<unknown>, right: ImageWorkJob<unknown>): number {
  const priorityOrder: Record<ImageWorkPriority, number> = {
    [IMAGE_WORK_PRIORITY.currentPreview]: 0,
    [IMAGE_WORK_PRIORITY.currentFull]: 1,
    [IMAGE_WORK_PRIORITY.currentMetadata]: 2,
    [IMAGE_WORK_PRIORITY.adjacentDirectional]: 3,
    [IMAGE_WORK_PRIORITY.visibleThumbnail]: 4,
    [IMAGE_WORK_PRIORITY.backgroundPreload]: 5,
  };

  const priorityDelta = priorityOrder[left.priority] - priorityOrder[right.priority];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.sequence - right.sequence;
}

// fallow-ignore-next-line unused-exports -- constructed directly in focused scheduler tests
export function createImageWorkScheduler(options: SchedulerOptions = {}) {
  const listeners = new Set<ImageWorkListener>();
  const queuedJobs: Array<ImageWorkJob<unknown>> = [];
  const jobsByKey = new Map<string, ImageWorkJob<unknown>>();
  let nextSequence = 0;
  let nextConsumerId = 0;
  let droppedQueued = 0;
  let maxConcurrent = options.maxConcurrent ?? 6;
  let maxInteractiveConcurrent = options.maxInteractiveConcurrent ?? 2;
  let maxVisibleConcurrent = options.maxVisibleConcurrent ?? 3;
  let maxBackgroundConcurrent = options.maxBackgroundConcurrent ?? 1;

  function getSnapshot(): ImageWorkSnapshot {
    const activeByPriority = createPrioritySnapshot();
    const queuedByPriority = createPrioritySnapshot();
    for (const job of jobsByKey.values()) {
      if (job.state === 'running') {
        activeByPriority[job.priority] += 1;
      } else if (job.state === 'queued') {
        queuedByPriority[job.priority] += 1;
      }
    }

    const inFlight = Array.from(jobsByKey.values()).filter((job) => job.state === 'running').length;
    return {
      queueDepth: queuedJobs.length,
      inFlight,
      droppedQueued,
      activeByPriority,
      queuedByPriority,
    };
  }

  function notify(): void {
    const snapshot = getSnapshot();
    options.onSnapshot?.(snapshot);
    for (const listener of listeners) {
      listener();
    }
  }

  function countRunning(bucket: ImageWorkBucket): number {
    let count = 0;
    for (const job of jobsByKey.values()) {
      if (job.state === 'running' && priorityBucket(job.priority) === bucket) {
        count += 1;
      }
    }
    return count;
  }

  function hasQueuedInteractiveWork(): boolean {
    return queuedJobs.some((job) => priorityBucket(job.priority) === 'interactive');
  }

  function hasRunningInteractiveWork(): boolean {
    return Array.from(jobsByKey.values()).some(
      (job) => job.state === 'running' && priorityBucket(job.priority) === 'interactive'
    );
  }

  function canStart(job: ImageWorkJob<unknown>): boolean {
    const runningTotal = Array.from(jobsByKey.values()).filter(
      (item) => item.state === 'running'
    ).length;
    if (runningTotal >= maxConcurrent) {
      return false;
    }

    const bucket = priorityBucket(job.priority);
    if (bucket === 'interactive') {
      return countRunning('interactive') < maxInteractiveConcurrent;
    }

    if (bucket === 'visible') {
      return (
        !(hasQueuedInteractiveWork() && countRunning('interactive') < maxInteractiveConcurrent) &&
        countRunning('visible') < maxVisibleConcurrent
      );
    }

    return (
      !hasQueuedInteractiveWork() &&
      !hasRunningInteractiveWork() &&
      countRunning('background') < maxBackgroundConcurrent
    );
  }

  function removeQueuedJob(job: ImageWorkJob<unknown>): boolean {
    const index = queuedJobs.indexOf(job);
    if (index < 0) {
      return false;
    }
    queuedJobs.splice(index, 1);
    return true;
  }

  function settleJob<T>(
    job: ImageWorkJob<T>,
    settle: (consumer: ImageWorkConsumer<T>) => void
  ): void {
    if (job.settled) {
      return;
    }

    job.settled = true;
    if (jobsByKey.get(job.key) === job) {
      jobsByKey.delete(job.key);
    }
    removeQueuedJob(job as ImageWorkJob<unknown>);
    for (const consumer of job.consumers.values()) {
      if (!consumer.canceled) {
        settle(consumer);
      }
    }
    job.consumers.clear();
  }

  function pump(): void {
    queuedJobs.sort(compareJobs);

    while (queuedJobs.length > 0) {
      const nextIndex = queuedJobs.findIndex((job) => canStart(job));
      if (nextIndex < 0) {
        return;
      }

      const [job] = queuedJobs.splice(nextIndex, 1);
      if (!job || job.consumers.size === 0) {
        if (job) {
          job.settled = true;
          if (jobsByKey.get(job.key) === job) {
            jobsByKey.delete(job.key);
          }
        }
        notify();
        continue;
      }

      job.state = 'running';
      notify();

      void Promise.resolve(job.run({ signal: job.controller.signal }))
        .then((result) => {
          settleJob(job, (consumer) => consumer.resolve(result));
        })
        .catch((error) => {
          settleJob(job, (consumer) => consumer.reject(error));
        })
        .finally(() => {
          notify();
          pump();
        });
    }
  }

  function promoteJob(job: ImageWorkJob<unknown>, priority: ImageWorkPriority): void {
    if (compareJobs({ ...job, priority }, job) < 0) {
      job.priority = priority;
    }
  }

  function schedule<T>(options: ScheduleOptions<T>): ImageWorkHandle<T> {
    if (options.signal?.aborted) {
      return {
        key: options.key,
        promise: Promise.reject(createAbortError()),
        cancel: () => {},
      };
    }

    const existing = jobsByKey.get(options.key) as ImageWorkJob<T> | undefined;
    const job =
      existing ??
      ({
        key: options.key,
        sourcePath: options.sourcePath,
        priority: options.priority,
        state: 'queued',
        sequence: nextSequence,
        settled: false,
        run: async ({ signal }) => options.run({ signal }),
        controller: new AbortController(),
        consumers: new Map<number, ImageWorkConsumer<T>>(),
      } satisfies ImageWorkJob<T>);

    if (!existing) {
      nextSequence += 1;
      jobsByKey.set(job.key, job as ImageWorkJob<unknown>);
      queuedJobs.push(job as ImageWorkJob<unknown>);
    } else {
      promoteJob(job as ImageWorkJob<unknown>, options.priority);
    }

    const consumerId = nextConsumerId;
    nextConsumerId += 1;
    let settled = false;
    let removeAbortListener: (() => void) | null = null;

    const promise = new Promise<T>((resolve, reject) => {
      job.consumers.set(consumerId, { resolve, reject, canceled: false });
    });
    void promise.catch(() => {});

    const cancel = () => {
      if (settled) {
        return;
      }

      settled = true;
      const consumer = job.consumers.get(consumerId);
      if (!consumer) {
        return;
      }

      consumer.canceled = true;
      consumer.reject(createAbortError());
      job.consumers.delete(consumerId);

      if (job.consumers.size === 0) {
        if (job.state === 'queued') {
          if (removeQueuedJob(job as ImageWorkJob<unknown>)) {
            droppedQueued += 1;
          }
          jobsByKey.delete(job.key);
          job.settled = true;
        } else {
          job.controller.abort();
          if (jobsByKey.get(job.key) === job) {
            jobsByKey.delete(job.key);
          }
          job.settled = true;
          pump();
        }
      }

      removeAbortListener?.();
      removeAbortListener = null;
      notify();
    };

    if (options.signal) {
      const abortListener = () => cancel();
      options.signal.addEventListener('abort', abortListener, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener('abort', abortListener);
    }

    void promise.then(
      () => {
        settled = true;
        removeAbortListener?.();
        removeAbortListener = null;
      },
      () => {
        settled = true;
        removeAbortListener?.();
        removeAbortListener = null;
      }
    );

    notify();
    pump();

    return {
      key: options.key,
      promise,
      cancel,
    };
  }

  function cancelQueued(filter: (task: ImageWorkTaskView) => boolean): number {
    let canceled = 0;

    for (const job of Array.from(jobsByKey.values())) {
      if (job.state !== 'queued') {
        continue;
      }

      if (
        !filter({
          key: job.key,
          sourcePath: job.sourcePath,
          priority: job.priority,
          state: job.state,
        })
      ) {
        continue;
      }

      canceled += 1;
      droppedQueued += 1;
      settleJob(job, (consumer) => consumer.reject(createAbortError()));
    }

    if (canceled > 0) {
      notify();
      pump();
    }

    return canceled;
  }

  function subscribe(listener: ImageWorkListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function configure(next: SchedulerOptions): void {
    if (typeof next.maxConcurrent === 'number') {
      maxConcurrent = Math.max(1, Math.floor(next.maxConcurrent));
    }
    if (typeof next.maxInteractiveConcurrent === 'number') {
      maxInteractiveConcurrent = Math.max(1, Math.floor(next.maxInteractiveConcurrent));
    }
    if (typeof next.maxVisibleConcurrent === 'number') {
      maxVisibleConcurrent = Math.max(1, Math.floor(next.maxVisibleConcurrent));
    }
    if (typeof next.maxBackgroundConcurrent === 'number') {
      maxBackgroundConcurrent = Math.max(0, Math.floor(next.maxBackgroundConcurrent));
    }
    notify();
    pump();
  }

  function resetForTests(): void {
    for (const job of Array.from(jobsByKey.values())) {
      settleJob(job, (consumer) => consumer.reject(createAbortError()));
    }
    queuedJobs.length = 0;
    jobsByKey.clear();
    nextSequence = 0;
    nextConsumerId = 0;
    droppedQueued = 0;
    maxConcurrent = options.maxConcurrent ?? 6;
    maxInteractiveConcurrent = options.maxInteractiveConcurrent ?? 2;
    maxVisibleConcurrent = options.maxVisibleConcurrent ?? 3;
    maxBackgroundConcurrent = options.maxBackgroundConcurrent ?? 1;
    notify();
  }

  return {
    schedule,
    cancelQueued,
    getSnapshot,
    subscribe,
    configure,
    resetForTests,
  };
}

const imageWorkTelemetryScheduler = createImageWorkScheduler({
  maxConcurrent: 6,
  maxInteractiveConcurrent: 2,
  maxVisibleConcurrent: 3,
  maxBackgroundConcurrent: 1,
  onSnapshot: (snapshot) => {
    const interactiveCount =
      snapshot.activeByPriority[IMAGE_WORK_PRIORITY.currentPreview] +
      snapshot.activeByPriority[IMAGE_WORK_PRIORITY.currentMetadata] +
      snapshot.activeByPriority[IMAGE_WORK_PRIORITY.currentFull];
    const visibleCount = snapshot.activeByPriority[IMAGE_WORK_PRIORITY.visibleThumbnail];
    const backgroundCount =
      snapshot.activeByPriority[IMAGE_WORK_PRIORITY.adjacentDirectional] +
      snapshot.activeByPriority[IMAGE_WORK_PRIORITY.backgroundPreload];

    setThumbnailQueueDepthTelemetry(
      snapshot.queuedByPriority[IMAGE_WORK_PRIORITY.visibleThumbnail]
    );
    setThumbnailInFlightTelemetry(visibleCount);
    setImageWorkQueueDepthTelemetry(snapshot.queueDepth);
    setImageWorkActiveCountTelemetry(snapshot.inFlight);
    setImageWorkActiveInteractiveTelemetry(interactiveCount);
    setImageWorkActiveVisibleTelemetry(visibleCount);
    setImageWorkActiveBackgroundTelemetry(backgroundCount);
    setImageWorkDroppedQueuedTelemetry(snapshot.droppedQueued);
  },
});

export const imageWorkScheduler = imageWorkTelemetryScheduler;

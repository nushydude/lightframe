import { create } from 'zustand';
import { saveCroppedCopy, saveScaledCopy, type CropRect } from '../services/tauriCommands';

type EditQueueJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
type EditQueueJobKind = 'scaled-copy' | 'cropped-copy';
type EditQueueSummaryCountKey =
  | 'queuedCount'
  | 'runningCount'
  | 'completedCount'
  | 'failedCount'
  | 'canceledCount';

interface EditQueueJobBase {
  id: string;
  kind: EditQueueJobKind;
  sourcePath: string;
  outputPath: string;
  status: EditQueueJobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface ScaledCopyQueueJob extends EditQueueJobBase {
  kind: 'scaled-copy';
  width: number;
  height: number;
  smoothing: number;
  sharpening: number;
}

export interface CroppedCopyQueueJob extends EditQueueJobBase {
  kind: 'cropped-copy';
  cropRect: CropRect;
  rotationDegrees: number;
}

export type EditQueueJob = ScaledCopyQueueJob | CroppedCopyQueueJob;

type EditQueueJobInput =
  | Omit<ScaledCopyQueueJob, 'id' | 'status' | 'createdAt' | 'startedAt' | 'finishedAt' | 'error'>
  | Omit<CroppedCopyQueueJob, 'id' | 'status' | 'createdAt' | 'startedAt' | 'finishedAt' | 'error'>;

interface EditQueueSummary {
  totalCount: number;
  queuedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  activeCount: number;
  finishedCount: number;
  currentJobId: string | null;
}

type EnqueueEditQueueJobResult = { ok: true; jobId: string } | { ok: false; error: string };

interface EditQueueState {
  jobs: EditQueueJob[];
  jobsVersion: number;
  summary: EditQueueSummary;
  isRunning: boolean;
  enqueueJob: (input: EditQueueJobInput) => EnqueueEditQueueJobResult;
  runQueue: () => void;
  pauseQueue: () => void;
  retryJob: (jobId: string) => void;
  cancelJob: (jobId: string) => void;
  clearFinished: () => void;
  reset: () => void;
}

let nextJobNumber = 1;

const EMPTY_SUMMARY: EditQueueSummary = {
  totalCount: 0,
  queuedCount: 0,
  runningCount: 0,
  completedCount: 0,
  failedCount: 0,
  canceledCount: 0,
  activeCount: 0,
  finishedCount: 0,
  currentJobId: null,
};

const STATUS_COUNT_KEYS: Record<EditQueueJobStatus, EditQueueSummaryCountKey> = {
  queued: 'queuedCount',
  running: 'runningCount',
  completed: 'completedCount',
  failed: 'failedCount',
  canceled: 'canceledCount',
};

function createJob(input: EditQueueJobInput): EditQueueJob {
  return {
    ...input,
    id: `edit-job-${nextJobNumber++}`,
    status: 'queued',
    createdAt: Date.now(),
  };
}

function getJobErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getNormalizedOutputPathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function getDuplicateOutputPathError(outputPath: string): string {
  return `An active queued export already targets this output path:\n${outputPath}`;
}

function hasActiveOutputPathConflict(jobs: EditQueueJob[], outputPath: string): boolean {
  const outputPathKey = getNormalizedOutputPathKey(outputPath);

  return jobs.some(
    (job) =>
      (job.status === 'queued' || job.status === 'running') &&
      getNormalizedOutputPathKey(job.outputPath) === outputPathKey
  );
}

function updateJobAtIndex(
  jobs: EditQueueJob[],
  index: number,
  updates: Partial<EditQueueJob>
): boolean {
  if (index < 0 || index >= jobs.length) {
    return false;
  }

  Object.assign(jobs[index], updates);
  return true;
}

function updateJobById(
  jobs: EditQueueJob[],
  jobId: string,
  expectedStatus: EditQueueJobStatus,
  updates: Partial<EditQueueJob>
): boolean {
  const index = jobs.findIndex((job) => job.id === jobId);
  if (index < 0 || jobs[index].status !== expectedStatus) {
    return false;
  }

  Object.assign(jobs[index], updates);
  return true;
}

function updateSummaryForStatusChange(
  summary: EditQueueSummary,
  fromStatus: EditQueueJobStatus,
  toStatus: EditQueueJobStatus,
  currentJobId: string | null
): EditQueueSummary {
  const fromKey = STATUS_COUNT_KEYS[fromStatus];
  const toKey = STATUS_COUNT_KEYS[toStatus];
  const next = {
    ...summary,
    [fromKey]: summary[fromKey] - 1,
    [toKey]: summary[toKey] + 1,
    currentJobId,
  };

  return {
    ...next,
    activeCount: next.queuedCount + next.runningCount,
    finishedCount: next.completedCount + next.failedCount + next.canceledCount,
  };
}

function updateSummaryForEnqueue(summary: EditQueueSummary): EditQueueSummary {
  return {
    ...summary,
    totalCount: summary.totalCount + 1,
    queuedCount: summary.queuedCount + 1,
    activeCount: summary.activeCount + 1,
  };
}

function findNextQueuedJobIndex(jobs: EditQueueJob[], startIndex: number): number {
  for (let index = startIndex; index < jobs.length; index += 1) {
    if (jobs[index].status === 'queued') {
      return index;
    }
  }

  for (let index = 0; index < startIndex; index += 1) {
    if (jobs[index].status === 'queued') {
      return index;
    }
  }

  return -1;
}

async function runJob(job: EditQueueJob): Promise<void> {
  if (job.kind === 'scaled-copy') {
    await saveScaledCopy(
      job.sourcePath,
      job.outputPath,
      job.width,
      job.height,
      job.smoothing,
      job.sharpening
    );
    return;
  }

  await saveCroppedCopy(job.sourcePath, job.cropRect, job.outputPath, job.rotationDegrees);
}

export const useEditQueueStore = create<EditQueueState>((set, get) => {
  let isDraining = false;
  let nextQueuedSearchIndex = 0;
  let drainGeneration = 0;

  const drainQueue = async () => {
    if (isDraining) {
      return;
    }

    isDraining = true;
    const generation = drainGeneration;
    try {
      while (get().isRunning && get().summary.queuedCount > 0) {
        const state = get();
        const nextJobIndex = findNextQueuedJobIndex(state.jobs, nextQueuedSearchIndex);

        if (nextJobIndex < 0) {
          set({ isRunning: false });
          return;
        }

        const nextJob = state.jobs[nextJobIndex];
        nextQueuedSearchIndex = nextJobIndex + 1;
        set((state) => ({
          ...(updateJobAtIndex(state.jobs, nextJobIndex, {
            status: 'running',
            startedAt: Date.now(),
            error: undefined,
          })
            ? { jobsVersion: state.jobsVersion + 1 }
            : {}),
          summary: updateSummaryForStatusChange(state.summary, 'queued', 'running', nextJob.id),
        }));

        try {
          await runJob(nextJob);
          if (generation !== drainGeneration) {
            return;
          }
          set((state) => {
            const didUpdate = updateJobById(state.jobs, nextJob.id, 'running', {
              status: 'completed',
              finishedAt: Date.now(),
              error: undefined,
            });
            if (!didUpdate) {
              return {};
            }

            return {
              jobsVersion: state.jobsVersion + 1,
              summary: updateSummaryForStatusChange(state.summary, 'running', 'completed', null),
            };
          });
        } catch (error) {
          if (generation !== drainGeneration) {
            return;
          }
          set((state) => {
            const didUpdate = updateJobById(state.jobs, nextJob.id, 'running', {
              status: 'failed',
              finishedAt: Date.now(),
              error: getJobErrorMessage(error),
            });
            if (!didUpdate) {
              return {};
            }

            return {
              jobsVersion: state.jobsVersion + 1,
              summary: updateSummaryForStatusChange(state.summary, 'running', 'failed', null),
            };
          });
        }
      }

      if (get().summary.queuedCount === 0) {
        set({ isRunning: false });
      }
    } finally {
      isDraining = false;
      if (get().isRunning && get().summary.queuedCount > 0) {
        void drainQueue();
      }
    }
  };

  return {
    jobs: [],
    jobsVersion: 0,
    summary: EMPTY_SUMMARY,
    isRunning: false,
    enqueueJob: (input) => {
      const state = get();
      if (hasActiveOutputPathConflict(state.jobs, input.outputPath)) {
        return { ok: false, error: getDuplicateOutputPathError(input.outputPath) };
      }

      const job = createJob(input);
      set((state) => ({
        jobs: [...state.jobs, job],
        jobsVersion: state.jobsVersion + 1,
        summary: updateSummaryForEnqueue(state.summary),
      }));
      return { ok: true, jobId: job.id };
    },
    runQueue: () => {
      if (get().summary.queuedCount === 0) {
        set({ isRunning: false });
        return;
      }

      set({ isRunning: true });
      void drainQueue();
    },
    pauseQueue: () => set({ isRunning: false }),
    retryJob: (jobId) => {
      const job = get().jobs.find((job) => job.id === jobId);
      if (!job || (job.status !== 'failed' && job.status !== 'canceled')) {
        return;
      }

      const previousStatus = job.status;
      if (hasActiveOutputPathConflict(get().jobs, job.outputPath)) {
        set((state) => ({
          ...(updateJobAtIndex(
            state.jobs,
            state.jobs.findIndex((item) => item.id === jobId),
            { error: getDuplicateOutputPathError(job.outputPath) }
          )
            ? { jobsVersion: state.jobsVersion + 1 }
            : {}),
        }));
        return;
      }

      set((state) => ({
        ...(updateJobAtIndex(
          state.jobs,
          state.jobs.findIndex((item) => item.id === jobId),
          {
            status: 'queued',
            startedAt: undefined,
            finishedAt: undefined,
            error: undefined,
          }
        )
          ? { jobsVersion: state.jobsVersion + 1 }
          : {}),
        summary: updateSummaryForStatusChange(state.summary, previousStatus, 'queued', null),
      }));

      if (get().isRunning) {
        void drainQueue();
      }
    },
    cancelJob: (jobId) => {
      const job = get().jobs.find((job) => job.id === jobId);
      if (!job || job.status !== 'queued') {
        return;
      }

      set((state) => ({
        ...(updateJobAtIndex(
          state.jobs,
          state.jobs.findIndex((item) => item.id === jobId),
          { status: 'canceled', finishedAt: Date.now() }
        )
          ? { jobsVersion: state.jobsVersion + 1 }
          : {}),
        summary: updateSummaryForStatusChange(state.summary, 'queued', 'canceled', null),
      }));
    },
    clearFinished: () => {
      const jobs = get().jobs.filter((job) => job.status === 'queued' || job.status === 'running');
      set((state) => ({
        jobs,
        jobsVersion: state.jobsVersion + 1,
        summary: {
          ...EMPTY_SUMMARY,
          totalCount: jobs.length,
          queuedCount: state.summary.queuedCount,
          runningCount: state.summary.runningCount,
          activeCount: state.summary.activeCount,
          currentJobId: state.summary.currentJobId,
        },
      }));
      nextQueuedSearchIndex = Math.min(nextQueuedSearchIndex, jobs.length);
    },
    reset: () => {
      nextJobNumber = 1;
      nextQueuedSearchIndex = 0;
      drainGeneration += 1;
      isDraining = false;
      set((state) => ({
        jobs: [],
        jobsVersion: state.jobsVersion + 1,
        summary: EMPTY_SUMMARY,
        isRunning: false,
      }));
    },
  };
});

import { create } from 'zustand';
import { saveCroppedCopy, saveScaledCopy, type CropRect } from '../services/tauriCommands';

export type EditQueueJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export type EditQueueJobKind = 'scaled-copy' | 'cropped-copy';

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

export type EditQueueJobInput =
  | Omit<ScaledCopyQueueJob, 'id' | 'status' | 'createdAt' | 'startedAt' | 'finishedAt' | 'error'>
  | Omit<CroppedCopyQueueJob, 'id' | 'status' | 'createdAt' | 'startedAt' | 'finishedAt' | 'error'>;

interface EditQueueState {
  jobs: EditQueueJob[];
  isRunning: boolean;
  enqueueJob: (input: EditQueueJobInput) => string;
  runQueue: () => void;
  pauseQueue: () => void;
  retryJob: (jobId: string) => void;
  cancelJob: (jobId: string) => void;
  clearFinished: () => void;
  reset: () => void;
}

let nextJobNumber = 1;

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

  const drainQueue = async () => {
    if (isDraining) {
      return;
    }

    isDraining = true;
    try {
      while (get().isRunning) {
        const nextJob = get().jobs.find((job) => job.status === 'queued');

        if (!nextJob) {
          set({ isRunning: false });
          return;
        }

        set((state) => ({
          jobs: state.jobs.map((job) =>
            job.id === nextJob.id
              ? {
                  ...job,
                  status: 'running',
                  startedAt: Date.now(),
                  error: undefined,
                }
              : job
          ),
        }));

        try {
          await runJob(nextJob);
          set((state) => ({
            jobs: state.jobs.map((job) =>
              job.id === nextJob.id && job.status === 'running'
                ? {
                    ...job,
                    status: 'completed',
                    finishedAt: Date.now(),
                    error: undefined,
                  }
                : job
            ),
          }));
        } catch (error) {
          set((state) => ({
            jobs: state.jobs.map((job) =>
              job.id === nextJob.id && job.status === 'running'
                ? {
                    ...job,
                    status: 'failed',
                    finishedAt: Date.now(),
                    error: getJobErrorMessage(error),
                  }
                : job
            ),
            isRunning: false,
          }));
        }
      }
    } finally {
      isDraining = false;
      if (get().isRunning && get().jobs.some((job) => job.status === 'queued')) {
        void drainQueue();
      }
    }
  };

  return {
    jobs: [],
    isRunning: false,
    enqueueJob: (input) => {
      const job = createJob(input);
      set((state) => ({ jobs: [...state.jobs, job] }));
      return job.id;
    },
    runQueue: () => {
      if (!get().jobs.some((job) => job.status === 'queued')) {
        set({ isRunning: false });
        return;
      }

      set({ isRunning: true });
      void drainQueue();
    },
    pauseQueue: () => set({ isRunning: false }),
    retryJob: (jobId) => {
      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === jobId && (job.status === 'failed' || job.status === 'canceled')
            ? {
                ...job,
                status: 'queued',
                startedAt: undefined,
                finishedAt: undefined,
                error: undefined,
              }
            : job
        ),
      }));

      if (get().isRunning) {
        void drainQueue();
      }
    },
    cancelJob: (jobId) => {
      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === jobId && job.status === 'queued'
            ? { ...job, status: 'canceled', finishedAt: Date.now() }
            : job
        ),
      }));
    },
    clearFinished: () => {
      set((state) => ({
        jobs: state.jobs.filter((job) => job.status === 'queued' || job.status === 'running'),
      }));
    },
    reset: () => {
      nextJobNumber = 1;
      isDraining = false;
      set({ jobs: [], isRunning: false });
    },
  };
});

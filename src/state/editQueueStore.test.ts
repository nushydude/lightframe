import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditQueueStore } from './editQueueStore';

const { saveCroppedCopyMock, saveScaledCopyMock, selectDestinationMock } = vi.hoisted(() => ({
  saveCroppedCopyMock: vi.fn(),
  saveScaledCopyMock: vi.fn(),
  selectDestinationMock: vi.fn(),
}));

vi.mock('../services/tauriCommands', () => ({
  getFileName: (path: string) => {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] ?? path;
  },
  saveCroppedCopyWithGrant: saveCroppedCopyMock,
  saveScaledCopyWithGrant: saveScaledCopyMock,
  selectDestination: selectDestinationMock,
}));

function exactDestination(index: number, operation: 'crop-copy' | 'scale-copy') {
  return {
    destinationGrantId: `grant-${index}`,
    relativeFileName: `output-${index}.jpg`,
    destinationOperation: operation,
  } as const;
}

describe('editQueueStore', () => {
  beforeEach(() => {
    useEditQueueStore.getState().reset();
    vi.clearAllMocks();
  });

  it('queues jobs without running them immediately', () => {
    const result = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Images/photo-scaled.jpg',
      ...exactDestination(1, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 10,
      sharpening: 20,
    });

    expect(result).toEqual({ ok: true, jobId: 'edit-job-1' });
    expect(useEditQueueStore.getState().jobs).toMatchObject([
      {
        id: 'edit-job-1',
        kind: 'scaled-copy',
        status: 'queued',
      },
    ]);
    expect(useEditQueueStore.getState().summary).toMatchObject({
      totalCount: 1,
      queuedCount: 1,
      activeCount: 1,
    });
    expect(saveScaledCopyMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate active output paths', () => {
    useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo-a.jpg',
      outputPath: 'C:/Images/photo-scaled.jpg',
      ...exactDestination(1, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });

    const result = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo-b.jpg',
      outputPath: 'C:\\Images\\PHOTO-SCALED.jpg',
      ...exactDestination(2, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('active queued export'),
    });
    expect(useEditQueueStore.getState().jobs).toHaveLength(1);
  });

  it('runs queued scale and crop copy jobs sequentially', async () => {
    saveScaledCopyMock.mockResolvedValue(undefined);
    saveCroppedCopyMock.mockResolvedValue(undefined);

    useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Images/photo-scaled.jpg',
      ...exactDestination(1, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 10,
      sharpening: 20,
    });
    useEditQueueStore.getState().enqueueJob({
      kind: 'cropped-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Images/photo-cropped.jpg',
      ...exactDestination(2, 'crop-copy'),
      cropRect: { x: 10, y: 20, width: 100, height: 80 },
      rotationDegrees: 90,
    });

    useEditQueueStore.getState().runQueue();

    await waitFor(() => {
      expect(useEditQueueStore.getState().jobs.map((job) => job.status)).toEqual([
        'completed',
        'completed',
      ]);
    });
    expect(useEditQueueStore.getState().isRunning).toBe(false);
    expect(saveScaledCopyMock).toHaveBeenCalledWith(
      'C:/Images/photo.jpg',
      'grant-1',
      'output-1.jpg',
      640,
      480,
      10,
      20
    );
    expect(saveCroppedCopyMock).toHaveBeenCalledWith(
      'C:/Images/photo.jpg',
      { x: 10, y: 20, width: 100, height: 80 },
      'grant-2',
      'output-2.jpg',
      90
    );
  });

  it('marks failures, keeps draining, and allows retrying the failed job', async () => {
    saveScaledCopyMock
      .mockRejectedValueOnce({
        message: 'disk full',
        destinationGrantConsumed: false,
      })
      .mockResolvedValue(undefined);
    saveCroppedCopyMock.mockResolvedValue(undefined);

    const result = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Images/photo-scaled.jpg',
      ...exactDestination(1, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });
    useEditQueueStore.getState().enqueueJob({
      kind: 'cropped-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Images/photo-cropped.jpg',
      ...exactDestination(2, 'crop-copy'),
      cropRect: { x: 10, y: 20, width: 100, height: 80 },
      rotationDegrees: 0,
    });

    useEditQueueStore.getState().runQueue();

    await waitFor(() => {
      expect(useEditQueueStore.getState().jobs.map((job) => job.status)).toEqual([
        'failed',
        'completed',
      ]);
    });
    expect(useEditQueueStore.getState().jobs[0]).toMatchObject({
      status: 'failed',
      error: 'disk full',
    });
    expect(useEditQueueStore.getState().summary).toMatchObject({
      failedCount: 1,
      completedCount: 1,
      activeCount: 0,
    });

    if (!result.ok) throw new Error(result.error);
    await useEditQueueStore.getState().retryJob(result.jobId);
    useEditQueueStore.getState().runQueue();

    await waitFor(() => {
      expect(useEditQueueStore.getState().jobs[0]).toMatchObject({
        status: 'completed',
        error: undefined,
      });
    });
    expect(saveScaledCopyMock).toHaveBeenCalledTimes(2);
  });

  it('finishes the running job correctly after clearing earlier finished jobs', async () => {
    let resolveSecondJob: (() => void) | undefined;
    saveScaledCopyMock.mockResolvedValueOnce(undefined).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSecondJob = resolve;
        })
    );

    useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo-1.jpg',
      outputPath: 'C:/Images/photo-1-scaled.jpg',
      ...exactDestination(1, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });
    useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo-2.jpg',
      outputPath: 'C:/Images/photo-2-scaled.jpg',
      ...exactDestination(2, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });

    useEditQueueStore.getState().runQueue();

    await waitFor(() => {
      expect(useEditQueueStore.getState().jobs.map((job) => job.status)).toEqual([
        'completed',
        'running',
      ]);
    });

    useEditQueueStore.getState().clearFinished();
    expect(useEditQueueStore.getState().jobs).toMatchObject([
      { id: 'edit-job-2', status: 'running' },
    ]);

    resolveSecondJob?.();

    await waitFor(() => {
      expect(useEditQueueStore.getState().jobs).toMatchObject([
        { id: 'edit-job-2', status: 'completed' },
      ]);
    });
    expect(useEditQueueStore.getState().summary).toMatchObject({
      runningCount: 0,
      completedCount: 1,
      activeCount: 0,
    });
  });

  it('preserves the current job id when changing other queued or failed jobs', async () => {
    let resolveRunningJob: (() => void) | undefined;
    saveScaledCopyMock.mockRejectedValueOnce(new Error('bad source')).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRunningJob = resolve;
        })
    );

    const failedResult = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo-1.jpg',
      outputPath: 'C:/Images/photo-1-scaled.jpg',
      ...exactDestination(1, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });
    const runningResult = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo-2.jpg',
      outputPath: 'C:/Images/photo-2-scaled.jpg',
      ...exactDestination(2, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });
    const queuedResult = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo-3.jpg',
      outputPath: 'C:/Images/photo-3-scaled.jpg',
      ...exactDestination(3, 'scale-copy'),
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });

    if (!failedResult.ok) throw new Error(failedResult.error);
    if (!runningResult.ok) throw new Error(runningResult.error);
    if (!queuedResult.ok) throw new Error(queuedResult.error);

    useEditQueueStore.getState().runQueue();

    await waitFor(() => {
      expect(useEditQueueStore.getState().jobs.map((job) => job.status)).toEqual([
        'failed',
        'running',
        'queued',
      ]);
    });
    expect(useEditQueueStore.getState().summary.currentJobId).toBe(runningResult.jobId);

    useEditQueueStore.getState().cancelJob(queuedResult.jobId);
    expect(useEditQueueStore.getState().summary.currentJobId).toBe(runningResult.jobId);

    await useEditQueueStore.getState().retryJob(failedResult.jobId);
    expect(useEditQueueStore.getState().summary.currentJobId).toBe(runningResult.jobId);

    resolveRunningJob?.();

    await waitFor(() => {
      expect(useEditQueueStore.getState().summary.currentJobId).toBe(null);
    });
  });

  it('preserves each exact grant while paused for two outputs in the same folder', async () => {
    saveScaledCopyMock.mockResolvedValue(undefined);
    useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/a.jpg',
      outputPath: 'C:/Exports/a.jpg',
      ...exactDestination(11, 'scale-copy'),
      width: 100,
      height: 100,
      smoothing: 0,
      sharpening: 0,
    });
    useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/b.jpg',
      outputPath: 'C:/Exports/b.jpg',
      ...exactDestination(12, 'scale-copy'),
      width: 100,
      height: 100,
      smoothing: 0,
      sharpening: 0,
    });

    expect(saveScaledCopyMock).not.toHaveBeenCalled();
    useEditQueueStore.getState().runQueue();
    await waitFor(() => expect(useEditQueueStore.getState().summary.completedCount).toBe(2));
    expect(saveScaledCopyMock.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      ['grant-11', 'output-11.jpg'],
      ['grant-12', 'output-12.jpg'],
    ]);
  });

  it('requires a fresh native selection before retrying a consumed exact grant', async () => {
    saveScaledCopyMock
      .mockRejectedValueOnce(new Error('DESTINATION_GRANT_CONSUMED: disk full'))
      .mockResolvedValueOnce(undefined);
    selectDestinationMock.mockResolvedValue({
      destinationGrantId: 'grant-fresh',
      relativeFileName: 'fresh.jpg',
      selectedPath: 'C:/Exports/fresh.jpg',
    });
    const result = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Exports/photo.jpg',
      ...exactDestination(1, 'scale-copy'),
      width: 100,
      height: 100,
      smoothing: 0,
      sharpening: 0,
    });
    if (!result.ok) throw new Error(result.error);
    useEditQueueStore.getState().runQueue();
    await waitFor(() => expect(useEditQueueStore.getState().jobs[0].status).toBe('failed'));

    await useEditQueueStore.getState().retryJob(result.jobId);
    expect(selectDestinationMock).toHaveBeenCalledWith('photo.jpg', 'scale-copy');
    expect(useEditQueueStore.getState().jobs[0]).toMatchObject({
      destinationGrantId: 'grant-fresh',
      relativeFileName: 'fresh.jpg',
      outputPath: 'C:/Exports/fresh.jpg',
      status: 'queued',
    });
    useEditQueueStore.getState().runQueue();
    await waitFor(() => expect(useEditQueueStore.getState().jobs[0].status).toBe('completed'));
    expect(saveScaledCopyMock.mock.calls[1].slice(1, 3)).toEqual(['grant-fresh', 'fresh.jpg']);
  });

  it('honors typed grant state and treats an untyped worker failure as consumed', async () => {
    saveScaledCopyMock.mockRejectedValueOnce({
      message: 'canceled before scheduling',
      destinationGrantConsumed: false,
    });
    const first = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/typed.jpg',
      outputPath: 'C:/Exports/typed.jpg',
      ...exactDestination(20, 'scale-copy'),
      width: 100,
      height: 100,
      smoothing: 0,
      sharpening: 0,
    });
    if (!first.ok) throw new Error(first.error);
    useEditQueueStore.getState().runQueue();
    await waitFor(() => expect(useEditQueueStore.getState().jobs[0].status).toBe('failed'));
    expect(useEditQueueStore.getState().jobs[0].destinationGrantConsumed).toBe(false);

    useEditQueueStore.getState().reset();
    saveScaledCopyMock.mockRejectedValueOnce(new Error('Task panicked during execution'));
    const second = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/panic.jpg',
      outputPath: 'C:/Exports/panic.jpg',
      ...exactDestination(21, 'scale-copy'),
      width: 100,
      height: 100,
      smoothing: 0,
      sharpening: 0,
    });
    if (!second.ok) throw new Error(second.error);
    useEditQueueStore.getState().runQueue();
    await waitFor(() => expect(useEditQueueStore.getState().jobs[0].status).toBe('failed'));
    expect(useEditQueueStore.getState().jobs[0].destinationGrantConsumed).toBe(true);
  });
});

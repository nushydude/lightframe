import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditQueueStore } from './editQueueStore';

const { saveCroppedCopyMock, saveScaledCopyMock } = vi.hoisted(() => ({
  saveCroppedCopyMock: vi.fn(),
  saveScaledCopyMock: vi.fn(),
}));

vi.mock('../services/tauriCommands', () => ({
  saveCroppedCopy: saveCroppedCopyMock,
  saveScaledCopy: saveScaledCopyMock,
}));

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
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });

    const result = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo-b.jpg',
      outputPath: 'C:\\Images\\PHOTO-SCALED.jpg',
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
      width: 640,
      height: 480,
      smoothing: 10,
      sharpening: 20,
    });
    useEditQueueStore.getState().enqueueJob({
      kind: 'cropped-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Images/photo-cropped.jpg',
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
      'C:/Images/photo-scaled.jpg',
      640,
      480,
      10,
      20
    );
    expect(saveCroppedCopyMock).toHaveBeenCalledWith(
      'C:/Images/photo.jpg',
      { x: 10, y: 20, width: 100, height: 80 },
      'C:/Images/photo-cropped.jpg',
      90
    );
  });

  it('marks failures, keeps draining, and allows retrying the failed job', async () => {
    saveScaledCopyMock.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    saveCroppedCopyMock.mockResolvedValue(undefined);

    const result = useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Images/photo-scaled.jpg',
      width: 640,
      height: 480,
      smoothing: 0,
      sharpening: 0,
    });
    useEditQueueStore.getState().enqueueJob({
      kind: 'cropped-copy',
      sourcePath: 'C:/Images/photo.jpg',
      outputPath: 'C:/Images/photo-cropped.jpg',
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
    useEditQueueStore.getState().retryJob(result.jobId);
    useEditQueueStore.getState().runQueue();

    await waitFor(() => {
      expect(useEditQueueStore.getState().jobs[0]).toMatchObject({
        status: 'completed',
        error: undefined,
      });
    });
    expect(saveScaledCopyMock).toHaveBeenCalledTimes(2);
  });
});

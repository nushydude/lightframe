import { useCallback, useMemo, useState, type UIEvent } from 'react';
import { getFileName } from '../services/tauriCommands';
import { useEditQueueStore, type EditQueueJob } from '../state/editQueueStore';

const QUEUE_ROW_SLOT_HEIGHT = 78;
const QUEUE_ROW_OVERSCAN = 4;

interface QueueListMetrics {
  scrollTop: number;
  viewportHeight: number;
}

interface VisibleJobRange {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
}

function getJobTitle(job: EditQueueJob): string {
  const fileName = getFileName(job.sourcePath);
  if (job.kind === 'scaled-copy') {
    return `Scale ${fileName}`;
  }

  return `Crop ${fileName}`;
}

function getJobDetail(job: EditQueueJob): string {
  if (job.kind === 'scaled-copy') {
    return `${job.width} x ${job.height}`;
  }

  return `${job.cropRect.width} x ${job.cropRect.height}`;
}

function getStatusLabel(status: EditQueueJob['status']): string {
  if (status === 'queued') return 'Queued';
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Done';
  if (status === 'failed') return 'Failed';
  return 'Canceled';
}

function getVisibleJobRange(jobCount: number, metrics: QueueListMetrics): VisibleJobRange {
  if (jobCount === 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0 };
  }

  const viewportHeight = Math.max(metrics.viewportHeight, QUEUE_ROW_SLOT_HEIGHT);
  const visibleSlotCount =
    Math.ceil(viewportHeight / QUEUE_ROW_SLOT_HEIGHT) + QUEUE_ROW_OVERSCAN * 2;
  const rawStartIndex = Math.floor(metrics.scrollTop / QUEUE_ROW_SLOT_HEIGHT) - QUEUE_ROW_OVERSCAN;
  const maxStartIndex = Math.max(0, jobCount - visibleSlotCount);
  const startIndex = Math.min(Math.max(0, rawStartIndex), maxStartIndex);
  const endIndex = Math.min(jobCount, startIndex + visibleSlotCount);

  return {
    startIndex,
    endIndex,
    totalHeight: jobCount * QUEUE_ROW_SLOT_HEIGHT,
  };
}

interface EditQueueRowProps {
  job: EditQueueJob;
  top: number;
  cancelJob: (jobId: string) => void;
  retryJob: (jobId: string) => void;
}

function EditQueueRow({ job, top, cancelJob, retryJob }: EditQueueRowProps) {
  return (
    <div className="edit-queue-virtual-row" style={{ transform: `translateY(${top}px)` }}>
      <div className={`edit-queue-row edit-queue-row--${job.status}`}>
        <div className="edit-queue-row-main">
          <div className="edit-queue-row-title">{getJobTitle(job)}</div>
          <div className="edit-queue-row-detail">
            {getJobDetail(job)}
            {' -> '}
            {getFileName(job.outputPath)}
          </div>
          {job.error && <div className="edit-queue-row-error">{job.error}</div>}
        </div>
        <div className="edit-queue-row-side">
          <span className="edit-queue-status">{getStatusLabel(job.status)}</span>
          {job.status === 'queued' && (
            <button
              className="edit-queue-inline-action"
              type="button"
              onClick={() => cancelJob(job.id)}
            >
              Cancel
            </button>
          )}
          {(job.status === 'failed' || job.status === 'canceled') && (
            <button
              className="edit-queue-inline-action"
              type="button"
              onClick={() => retryJob(job.id)}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EditQueuePanel() {
  const jobs = useEditQueueStore((state) => state.jobs);
  const jobsVersion = useEditQueueStore((state) => state.jobsVersion);
  const summary = useEditQueueStore((state) => state.summary);
  const isRunning = useEditQueueStore((state) => state.isRunning);
  const runQueue = useEditQueueStore((state) => state.runQueue);
  const pauseQueue = useEditQueueStore((state) => state.pauseQueue);
  const retryJob = useEditQueueStore((state) => state.retryJob);
  const cancelJob = useEditQueueStore((state) => state.cancelJob);
  const clearFinished = useEditQueueStore((state) => state.clearFinished);

  const queuedCount = summary.queuedCount;
  const runningCount = summary.runningCount;
  const finishedCount = summary.finishedCount;
  const hasJobs = jobs.length > 0;
  const canClearFinished = finishedCount > 0;
  const [listMetrics, setListMetrics] = useState<QueueListMetrics>({
    scrollTop: 0,
    viewportHeight: 320,
  });
  const visibleRange = useMemo(
    () => getVisibleJobRange(jobs.length, listMetrics),
    [jobs.length, listMetrics]
  );
  void jobsVersion;
  const visibleJobs = jobs.slice(visibleRange.startIndex, visibleRange.endIndex);

  const updateListMetrics = useCallback((element: HTMLDivElement) => {
    setListMetrics((current) => {
      const next = {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight || current.viewportHeight,
      };

      return next.scrollTop === current.scrollTop && next.viewportHeight === current.viewportHeight
        ? current
        : next;
    });
  }, []);

  const setListElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) {
        updateListMetrics(element);
      }
    },
    [updateListMetrics]
  );

  const handleListScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      updateListMetrics(event.currentTarget);
    },
    [updateListMetrics]
  );

  return (
    <div className="edit-queue-panel" role="region" aria-label="Editing queue">
      <div className="edit-queue-header">
        <div>
          <div className="edit-queue-title">Editing Queue</div>
          <div className="edit-queue-subtitle">
            {runningCount > 0
              ? 'Running in background'
              : queuedCount > 0
                ? `${queuedCount} ready`
                : 'No waiting jobs'}
          </div>
        </div>
        <div className="edit-queue-count" aria-label={`${jobs.length} editing jobs`}>
          {jobs.length}
        </div>
      </div>

      <div className="edit-queue-actions">
        <button
          className="setting-button-primary"
          type="button"
          onClick={runQueue}
          disabled={queuedCount === 0 || isRunning}
        >
          Run
        </button>
        <button
          className="setting-button-secondary"
          type="button"
          onClick={pauseQueue}
          disabled={!isRunning}
        >
          Pause
        </button>
        <button
          className="setting-button-secondary"
          type="button"
          onClick={clearFinished}
          disabled={!canClearFinished}
        >
          Clear
        </button>
      </div>

      <div className="edit-queue-list" ref={setListElement} onScroll={handleListScroll}>
        {!hasJobs ? (
          <div className="edit-queue-empty">Queue scaled or cropped copies from the viewer.</div>
        ) : (
          <div
            className="edit-queue-virtual-spacer"
            style={{ height: `${visibleRange.totalHeight}px` }}
          >
            {visibleJobs.map((job, offset) => (
              <EditQueueRow
                cancelJob={cancelJob}
                job={job}
                key={job.id}
                retryJob={retryJob}
                top={(visibleRange.startIndex + offset) * QUEUE_ROW_SLOT_HEIGHT}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

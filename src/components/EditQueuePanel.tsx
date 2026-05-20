import { getFileName } from '../services/tauriCommands';
import { useEditQueueStore, type EditQueueJob } from '../state/editQueueStore';

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
  void jobsVersion;
  const hasJobs = jobs.length > 0;
  const canClearFinished = finishedCount > 0;

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

      <div className="edit-queue-list">
        {!hasJobs ? (
          <div className="edit-queue-empty">Queue scaled or cropped copies from the viewer.</div>
        ) : (
          jobs.map((job) => (
            <div className={`edit-queue-row edit-queue-row--${job.status}`} key={job.id}>
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
          ))
        )}
      </div>
    </div>
  );
}

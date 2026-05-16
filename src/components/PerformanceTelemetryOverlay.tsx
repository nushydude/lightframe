import type { PerformanceTelemetrySnapshot } from '../services/performanceTelemetry';
import { usePerformanceTelemetrySnapshot } from '../services/performanceTelemetry';
import { formatBytesForHumans } from '../services/cacheMemory';

interface PerformanceTelemetryOverlayProps {
  snapshot?: PerformanceTelemetrySnapshot;
  onReset?: () => void;
}

type TelemetryRow = {
  id: string;
  label: string;
  currentMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};

function formatMilliseconds(value: number | null): string {
  if (value == null) {
    return '--';
  }

  return `${Math.round(value)} ms`;
}

function formatRate(value: number | null): string {
  if (value == null) {
    return '--';
  }

  return `${Math.round(value * 100)}%`;
}

function formatCacheUsage(estimatedBytes: number, budgetBytes: number): string {
  return `est. ${formatBytesForHumans(estimatedBytes)} / ${formatBytesForHumans(budgetBytes)} budget`;
}

function formatCodecBackend(backend: string | null, nativeDecodeSupported: boolean | null): string {
  if (!backend) {
    return '--';
  }

  return nativeDecodeSupported ? `${backend} (native)` : backend;
}

function buildRows(snapshot: PerformanceTelemetrySnapshot): TelemetryRow[] {
  return [
    {
      id: 'startup',
      label: 'App start -> first image',
      ...snapshot.latencies.startupToFirstImageKnown,
    },
    {
      id: 'preview',
      label: 'Select -> preview visible',
      ...snapshot.latencies.imageSelectToPreviewVisible,
    },
    {
      id: 'full',
      label: 'Select -> full ready',
      ...snapshot.latencies.imageSelectToFullReady,
    },
    {
      id: 'keydown',
      label: 'Keydown -> source update',
      ...snapshot.latencies.navigationKeydownToVisibleSourceUpdate,
    },
    {
      id: 'folder-open',
      label: 'Folder open -> first visible',
      ...snapshot.latencies.folderOpenToFirstImageVisible,
    },
    {
      id: 'folder-scan',
      label: 'Folder scan',
      ...snapshot.latencies.folderScan,
    },
    {
      id: 'preview-generation',
      label: 'Preview generation',
      ...snapshot.latencies.previewGeneration,
    },
  ];
}

export function PerformanceTelemetryOverlay({
  snapshot,
  onReset,
}: PerformanceTelemetryOverlayProps) {
  const liveSnapshot = usePerformanceTelemetrySnapshot();
  const resolvedSnapshot = snapshot ?? liveSnapshot;
  const rows = buildRows(resolvedSnapshot);

  return (
    <aside
      className="performance-telemetry-overlay"
      role="complementary"
      aria-label="Performance telemetry"
    >
      <div className="performance-telemetry-header">
        <div>
          <h2>Performance Telemetry</h2>
          <p>{resolvedSnapshot.enabled ? 'Live metrics' : 'Telemetry disabled'}</p>
        </div>
        <button type="button" onClick={onReset}>
          Reset
        </button>
      </div>

      <div className="performance-telemetry-section">
        <h3>Current Image</h3>
        <dl>
          <div>
            <dt>Path</dt>
            <dd>{resolvedSnapshot.currentImage.path ?? '--'}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{resolvedSnapshot.currentImage.selectionKind ?? '--'}</dd>
          </div>
          <div>
            <dt>Codec</dt>
            <dd>
              {formatCodecBackend(
                resolvedSnapshot.currentImage.codecBackend,
                resolvedSnapshot.currentImage.nativeDecodeSupported
              )}
            </dd>
          </div>
          <div>
            <dt>Preview</dt>
            <dd>{formatMilliseconds(resolvedSnapshot.currentImage.previewVisibleMs)}</dd>
          </div>
          <div>
            <dt>Full</dt>
            <dd>{formatMilliseconds(resolvedSnapshot.currentImage.fullResolutionReadyMs)}</dd>
          </div>
          <div>
            <dt>Src update</dt>
            <dd>{formatMilliseconds(resolvedSnapshot.currentImage.visibleSourceUpdatedMs)}</dd>
          </div>
        </dl>
      </div>

      <div className="performance-telemetry-section">
        <h3>Latency</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Current</th>
              <th scope="col">p50</th>
              <th scope="col">p95</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.label}</th>
                <td>{formatMilliseconds(row.currentMs)}</td>
                <td>{formatMilliseconds(row.p50Ms)}</td>
                <td>{formatMilliseconds(row.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="performance-telemetry-section">
        <h3>Caches</h3>
        <dl>
          <div>
            <dt>Thumbnails</dt>
            <dd>
              {formatRate(resolvedSnapshot.caches.thumbnail.hitRate)} hit,{' '}
              {resolvedSnapshot.caches.thumbnail.entries} entries,{' '}
              {formatCacheUsage(
                resolvedSnapshot.caches.thumbnail.estimatedBytes,
                resolvedSnapshot.caches.thumbnail.budgetBytes
              )}
            </dd>
          </div>
          <div>
            <dt>Preview assets</dt>
            <dd>
              {formatRate(resolvedSnapshot.caches.previewAssets.hitRate)} hit,{' '}
              {resolvedSnapshot.caches.previewAssets.entries} entries,{' '}
              {formatCacheUsage(
                resolvedSnapshot.caches.previewAssets.estimatedBytes,
                resolvedSnapshot.caches.previewAssets.budgetBytes
              )}
            </dd>
          </div>
          <div>
            <dt>Full assets</dt>
            <dd>
              {formatRate(resolvedSnapshot.caches.fullAssets.hitRate)} hit,{' '}
              {resolvedSnapshot.caches.fullAssets.entries} entries
            </dd>
          </div>
        </dl>
      </div>

      <div className="performance-telemetry-section">
        <h3>Queues</h3>
        <dl>
          <div>
            <dt>Thumbnail depth</dt>
            <dd>{resolvedSnapshot.queues.thumbnailQueueDepth}</dd>
          </div>
          <div>
            <dt>Thumbnail in flight</dt>
            <dd>{resolvedSnapshot.queues.thumbnailInFlight}</dd>
          </div>
          <div>
            <dt>Image work depth</dt>
            <dd>{resolvedSnapshot.queues.imageWorkQueueDepth}</dd>
          </div>
          <div>
            <dt>Image work active</dt>
            <dd>{resolvedSnapshot.queues.imageWorkActiveCount}</dd>
          </div>
          <div>
            <dt>Interactive active</dt>
            <dd>{resolvedSnapshot.queues.imageWorkActiveInteractive}</dd>
          </div>
          <div>
            <dt>Visible active</dt>
            <dd>{resolvedSnapshot.queues.imageWorkActiveVisible}</dd>
          </div>
          <div>
            <dt>Background active</dt>
            <dd>{resolvedSnapshot.queues.imageWorkActiveBackground}</dd>
          </div>
          <div>
            <dt>Dropped queued</dt>
            <dd>{resolvedSnapshot.queues.imageWorkDroppedQueued}</dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}

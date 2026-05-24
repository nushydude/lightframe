import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PerformanceTelemetrySnapshot } from '../services/performanceTelemetry';
import { PerformanceTelemetryOverlay } from './PerformanceTelemetryOverlay';

const snapshot: PerformanceTelemetrySnapshot = {
  enabled: true,
  currentImage: {
    path: 'C:/images/current.jpg',
    selectionKind: 'keyboard-next',
    codecBackend: 'windows_native',
    nativeDecodeSupported: true,
    previewVisibleMs: 32,
    fullResolutionReadyMs: 64,
    visibleSourceUpdatedMs: 12,
  },
  startupPhases: {
    settingsAndCurationLoadMs: 48,
    cliResolveMs: 12,
    initialImageOpenMs: 85,
    firstImageKnownMs: 120,
  },
  folderOpenPhases: {
    source: 'cache',
    indexReadMs: 6,
    reconcileMs: 14,
    firstImageVisibleMs: 85,
    backgroundRefreshMs: 90,
  },
  sessionSummary: {
    startup: 'Startup was led by startup image open (85 ms); first image settled in 120 ms.',
    folderOpen:
      'cached index showed the first image in 85 ms; background refresh finished in 90 ms.',
  },
  latencies: {
    startupToFirstImageKnown: { currentMs: 120, p50Ms: 100, p95Ms: 180, sampleCount: 4 },
    imageSelectToPreviewVisible: { currentMs: 32, p50Ms: 28, p95Ms: 44, sampleCount: 7 },
    imageSelectToFullReady: { currentMs: 64, p50Ms: 58, p95Ms: 80, sampleCount: 7 },
    navigationKeydownToVisibleSourceUpdate: {
      currentMs: 12,
      p50Ms: 10,
      p95Ms: 18,
      sampleCount: 6,
    },
    folderOpenToFirstImageVisible: { currentMs: 85, p50Ms: 80, p95Ms: 100, sampleCount: 3 },
    folderIndexRead: { currentMs: 6, p50Ms: 5, p95Ms: 9, sampleCount: 4 },
    folderScan: { currentMs: 45, p50Ms: 42, p95Ms: 60, sampleCount: 5 },
    previewGeneration: { currentMs: 18, p50Ms: 16, p95Ms: 24, sampleCount: 5 },
    tileGeneration: { currentMs: 22, p50Ms: 20, p95Ms: 30, sampleCount: 4 },
  },
  caches: {
    thumbnail: {
      hits: 8,
      misses: 2,
      hitRate: 0.8,
      entries: 40,
      estimatedBytes: 32 * 1024 * 1024,
      budgetBytes: 64 * 1024 * 1024,
    },
    previewAssets: {
      hits: 6,
      misses: 4,
      hitRate: 0.6,
      entries: 10,
      estimatedBytes: 96 * 1024 * 1024,
      budgetBytes: 192 * 1024 * 1024,
    },
    fullAssets: { hits: 9, misses: 1, hitRate: 0.9, entries: 5 },
  },
  queues: {
    thumbnailQueueDepth: 3,
    thumbnailInFlight: 2,
    imageWorkQueueDepth: 5,
    imageWorkActiveCount: 4,
    imageWorkActiveInteractive: 2,
    imageWorkActiveVisible: 1,
    imageWorkActiveBackground: 1,
    imageWorkDroppedQueued: 7,
  },
};

describe('PerformanceTelemetryOverlay', () => {
  it('renders telemetry metrics from a supplied snapshot and resets on demand', () => {
    const onReset = vi.fn();

    render(<PerformanceTelemetryOverlay snapshot={snapshot} onReset={onReset} />);

    expect(
      screen.getByRole('complementary', { name: 'Performance telemetry' })
    ).toBeInTheDocument();
    expect(screen.getByText('C:/images/current.jpg')).toBeInTheDocument();
    expect(screen.getByText(/Startup was led by startup image open/)).toBeInTheDocument();
    expect(screen.getByText(/background refresh finished in 90 ms/i)).toBeInTheDocument();
    expect(screen.getByText('Settings + curation')).toBeInTheDocument();
    expect(screen.getByText('Last Folder Open')).toBeInTheDocument();
    expect(screen.getByText('Cached index')).toBeInTheDocument();
    expect(screen.getByText('keyboard-next')).toBeInTheDocument();
    expect(screen.getByText('windows_native (native)')).toBeInTheDocument();
    expect(screen.getAllByText('32 ms')).toHaveLength(2);
    expect(screen.getAllByText('64 ms')).toHaveLength(2);
    expect(
      screen.getByText(/80%\s+hit,\s+40 entries,\s+est. 32 MB \/ 64 MB budget/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/60%\s+hit,\s+10 entries,\s+est. 96 MB \/ 192 MB budget/)
    ).toBeInTheDocument();
    expect(screen.getByText(/90%\s+hit,\s+5 entries/)).toBeInTheDocument();
    expect(screen.getByText('Thumbnail depth')).toBeInTheDocument();
    expect(screen.getByText('Image work depth')).toBeInTheDocument();
    expect(screen.getByText('Dropped queued')).toBeInTheDocument();
    expect(screen.getByText('Folder index read')).toBeInTheDocument();
    expect(screen.getByText('Tile generation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

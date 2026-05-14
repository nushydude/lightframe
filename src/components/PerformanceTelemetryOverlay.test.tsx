import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PerformanceTelemetrySnapshot } from '../services/performanceTelemetry';
import { PerformanceTelemetryOverlay } from './PerformanceTelemetryOverlay';

const snapshot: PerformanceTelemetrySnapshot = {
  enabled: true,
  currentImage: {
    path: 'C:/images/current.jpg',
    selectionKind: 'keyboard-next',
    previewVisibleMs: 32,
    fullResolutionReadyMs: 64,
    visibleSourceUpdatedMs: 12,
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
    folderScan: { currentMs: 45, p50Ms: 42, p95Ms: 60, sampleCount: 5 },
    previewGeneration: { currentMs: 18, p50Ms: 16, p95Ms: 24, sampleCount: 5 },
  },
  caches: {
    thumbnail: { hits: 8, misses: 2, hitRate: 0.8, entries: 40 },
    previewAssets: { hits: 6, misses: 4, hitRate: 0.6, entries: 10 },
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
    expect(screen.getByText('keyboard-next')).toBeInTheDocument();
    expect(screen.getAllByText('32 ms')).toHaveLength(2);
    expect(screen.getAllByText('64 ms')).toHaveLength(2);
    expect(screen.getByText(/80%\s+hit,\s+40 entries/)).toBeInTheDocument();
    expect(screen.getByText(/60%\s+hit,\s+10 entries/)).toBeInTheDocument();
    expect(screen.getByText(/90%\s+hit,\s+5 entries/)).toBeInTheDocument();
    expect(screen.getByText('Thumbnail depth')).toBeInTheDocument();
    expect(screen.getByText('Image work depth')).toBeInTheDocument();
    expect(screen.getByText('Dropped queued')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RollingLatencySummary,
  beginFolderOpenTelemetry,
  beginNavigationKeydownTelemetry,
  clearPendingFolderOpenTelemetry,
  getPerformanceTelemetrySnapshot,
  markPerformanceTelemetryAppStart,
  measurePerformanceSpan,
  recordFullAssetCacheHit,
  recordFullAssetCacheMiss,
  recordFullResolutionReadyTelemetry,
  recordImageSelectedTelemetry,
  recordPreviewAssetCacheHit,
  recordPreviewAssetCacheMiss,
  recordPreviewVisibleTelemetry,
  recordStartupFirstImageKnownTelemetry,
  recordThumbnailCacheHit,
  recordThumbnailCacheMiss,
  recordVisibleImageSourceUpdatedTelemetry,
  resetPerformanceTelemetry,
  resetPerformanceTelemetryForTests,
  setFullAssetCacheEntryCountTelemetry,
  setNextImageSelectionKind,
  setPerformanceTelemetryEnabled,
  setPreviewAssetCacheEntryCountTelemetry,
  setThumbnailCacheEntryCountTelemetry,
  setThumbnailInFlightTelemetry,
  setThumbnailQueueDepthTelemetry,
  startPerformanceSpan,
} from './performanceTelemetry';

describe('performanceTelemetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPerformanceTelemetryForTests();
  });

  it('tracks spans, counters, gauges, and current-image timings when enabled', async () => {
    let currentTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => currentTime);

    markPerformanceTelemetryAppStart();
    setPerformanceTelemetryEnabled(true);

    currentTime = 25;
    recordStartupFirstImageKnownTelemetry();

    currentTime = 30;
    setNextImageSelectionKind('open-image');
    recordImageSelectedTelemetry('C:/images/a.jpg');

    currentTime = 55;
    recordPreviewVisibleTelemetry('C:/images/a.jpg');

    currentTime = 65;
    recordFullResolutionReadyTelemetry('C:/images/a.jpg');

    currentTime = 90;
    beginNavigationKeydownTelemetry('next');

    currentTime = 105;
    recordImageSelectedTelemetry('C:/images/b.jpg');

    currentTime = 120;
    recordVisibleImageSourceUpdatedTelemetry('C:/images/b.jpg');

    currentTime = 140;
    beginFolderOpenTelemetry();
    setNextImageSelectionKind('folder-open');

    currentTime = 170;
    recordImageSelectedTelemetry('C:/images/c.jpg');

    currentTime = 185;
    recordPreviewVisibleTelemetry('C:/images/c.jpg');

    currentTime = 200;
    await measurePerformanceSpan('folderScan', async () => {
      currentTime = 215;
      return 'done';
    });

    recordThumbnailCacheHit();
    recordThumbnailCacheMiss();
    recordPreviewAssetCacheHit();
    recordPreviewAssetCacheMiss();
    recordFullAssetCacheHit();
    recordFullAssetCacheMiss();
    setThumbnailQueueDepthTelemetry(4);
    setThumbnailInFlightTelemetry(2);
    setThumbnailCacheEntryCountTelemetry(8);
    setPreviewAssetCacheEntryCountTelemetry(3);
    setFullAssetCacheEntryCountTelemetry(5);

    const snapshot = getPerformanceTelemetrySnapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.currentImage.path).toBe('C:/images/c.jpg');
    expect(snapshot.currentImage.selectionKind).toBe('folder-open');
    expect(snapshot.currentImage.previewVisibleMs).toBe(15);
    expect(snapshot.currentImage.fullResolutionReadyMs).toBeNull();
    expect(snapshot.currentImage.visibleSourceUpdatedMs).toBeNull();
    expect(snapshot.latencies.startupToFirstImageKnown.currentMs).toBe(25);
    expect(snapshot.latencies.imageSelectToPreviewVisible.currentMs).toBe(15);
    expect(snapshot.latencies.imageSelectToFullReady.currentMs).toBe(35);
    expect(snapshot.latencies.navigationKeydownToVisibleSourceUpdate.currentMs).toBe(30);
    expect(snapshot.latencies.folderOpenToFirstImageVisible.currentMs).toBe(45);
    expect(snapshot.latencies.folderScan.currentMs).toBe(15);
    expect(snapshot.caches.thumbnail.hitRate).toBe(0.5);
    expect(snapshot.caches.previewAssets.hitRate).toBe(0.5);
    expect(snapshot.caches.fullAssets.hitRate).toBe(0.5);
    expect(snapshot.caches.thumbnail.entries).toBe(8);
    expect(snapshot.caches.previewAssets.entries).toBe(3);
    expect(snapshot.caches.fullAssets.entries).toBe(5);
    expect(snapshot.queues.thumbnailQueueDepth).toBe(4);
    expect(snapshot.queues.thumbnailInFlight).toBe(2);
  });

  it('keeps rolling latency summaries bounded and resets metrics cleanly', () => {
    const summary = new RollingLatencySummary(4);
    summary.record(10);
    summary.record(20);
    summary.record(30);
    summary.record(40);
    summary.record(50);

    expect(summary.snapshot()).toEqual({
      currentMs: 50,
      p50Ms: 30,
      p95Ms: 40,
      sampleCount: 4,
    });

    setPerformanceTelemetryEnabled(true);
    setThumbnailQueueDepthTelemetry(9);
    recordThumbnailCacheHit();
    recordThumbnailCacheMiss();
    resetPerformanceTelemetry();

    const snapshot = getPerformanceTelemetrySnapshot();
    expect(snapshot.currentImage.path).toBeNull();
    expect(snapshot.latencies.folderScan.sampleCount).toBe(0);
    expect(snapshot.caches.thumbnail.hits).toBe(0);
    expect(snapshot.caches.thumbnail.misses).toBe(0);
    expect(snapshot.caches.thumbnail.hitRate).toBeNull();
    expect(snapshot.queues.thumbnailQueueDepth).toBe(0);
  });

  it('stays no-op while disabled', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(100);

    const span = startPerformanceSpan('previewGeneration');

    expect(span.end()).toBeNull();

    const snapshot = getPerformanceTelemetrySnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.latencies.previewGeneration.sampleCount).toBe(0);
    expect(snapshot.caches.thumbnail.hits).toBe(0);
    expect(snapshot.queues.thumbnailQueueDepth).toBe(0);
  });

  it('completes folder-open timing on full-resolution visibility and clears stale folder tokens', () => {
    let currentTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => currentTime);

    setPerformanceTelemetryEnabled(true);

    currentTime = 10;
    beginFolderOpenTelemetry(1);
    clearPendingFolderOpenTelemetry(2);

    currentTime = 30;
    setNextImageSelectionKind('folder-open');
    recordImageSelectedTelemetry('C:/images/full-only.jpg');

    currentTime = 55;
    recordFullResolutionReadyTelemetry('C:/images/full-only.jpg');

    const snapshot = getPerformanceTelemetrySnapshot();
    expect(snapshot.latencies.folderOpenToFirstImageVisible.currentMs).toBe(45);
    expect(snapshot.latencies.imageSelectToPreviewVisible.currentMs).toBe(25);
    expect(snapshot.latencies.imageSelectToFullReady.currentMs).toBe(25);

    clearPendingFolderOpenTelemetry(1);
    expect(
      getPerformanceTelemetrySnapshot().latencies.folderOpenToFirstImageVisible.currentMs
    ).toBe(45);
  });

  it('does not let an older current image consume a newer folder-open timing token', () => {
    let currentTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => currentTime);

    setPerformanceTelemetryEnabled(true);

    currentTime = 10;
    setNextImageSelectionKind('open-image');
    recordImageSelectedTelemetry('C:/images/older.jpg');

    currentTime = 20;
    beginFolderOpenTelemetry(7);

    currentTime = 30;
    recordPreviewVisibleTelemetry('C:/images/older.jpg');

    currentTime = 40;
    setNextImageSelectionKind('folder-open');
    recordImageSelectedTelemetry('C:/images/new-folder.jpg');

    currentTime = 70;
    recordFullResolutionReadyTelemetry('C:/images/new-folder.jpg');

    const snapshot = getPerformanceTelemetrySnapshot();
    expect(snapshot.latencies.folderOpenToFirstImageVisible.currentMs).toBe(50);
    expect(snapshot.latencies.folderOpenToFirstImageVisible.sampleCount).toBe(1);
  });

  it('retargets same-path folder-open selections so later unrelated loads cannot consume the token', () => {
    let currentTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => currentTime);

    setPerformanceTelemetryEnabled(true);

    currentTime = 10;
    setNextImageSelectionKind('open-image');
    recordImageSelectedTelemetry('C:/images/same-path.jpg');

    currentTime = 20;
    beginFolderOpenTelemetry(9);

    currentTime = 30;
    setNextImageSelectionKind('folder-open');
    recordImageSelectedTelemetry('C:/images/same-path.jpg');

    currentTime = 40;
    setNextImageSelectionKind('open-image');
    recordImageSelectedTelemetry('C:/images/other.jpg');

    currentTime = 60;
    recordPreviewVisibleTelemetry('C:/images/other.jpg');

    const snapshot = getPerformanceTelemetrySnapshot();
    expect(snapshot.currentImage.path).toBe('C:/images/other.jpg');
    expect(snapshot.currentImage.selectionKind).toBe('open-image');
    expect(snapshot.latencies.folderOpenToFirstImageVisible.sampleCount).toBe(0);
  });
});

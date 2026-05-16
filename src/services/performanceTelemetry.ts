import { useSyncExternalStore } from 'react';

const LATENCY_HISTORY_LIMIT = 64;

type TelemetryListener = () => void;

type ImageSelectionKind =
  | 'open-image'
  | 'startup-open'
  | 'folder-open'
  | 'keyboard-next'
  | 'keyboard-prev'
  | 'other';

export type TelemetryLatencyMetricKey =
  | 'startupToFirstImageKnown'
  | 'imageSelectToPreviewVisible'
  | 'imageSelectToFullReady'
  | 'navigationKeydownToVisibleSourceUpdate'
  | 'folderOpenToFirstImageVisible'
  | 'folderScan'
  | 'previewGeneration';

type CounterKey =
  | 'thumbnailCacheHits'
  | 'thumbnailCacheMisses'
  | 'previewAssetCacheHits'
  | 'previewAssetCacheMisses'
  | 'fullAssetCacheHits'
  | 'fullAssetCacheMisses';

type GaugeKey =
  | 'thumbnailQueueDepth'
  | 'thumbnailInFlight'
  | 'thumbnailCacheEntries'
  | 'thumbnailCacheEstimatedBytes'
  | 'thumbnailCacheBudgetBytes'
  | 'previewAssetCacheEntries'
  | 'previewAssetCacheEstimatedBytes'
  | 'previewAssetCacheBudgetBytes'
  | 'fullAssetCacheEntries'
  | 'imageWorkQueueDepth'
  | 'imageWorkActiveCount'
  | 'imageWorkActiveInteractive'
  | 'imageWorkActiveVisible'
  | 'imageWorkActiveBackground'
  | 'imageWorkDroppedQueued';

type ActiveSpan = {
  key: number;
  metric: TelemetryLatencyMetricKey;
  startedAt: number;
  completed: boolean;
};

type PendingNavigationKeydown = {
  direction: 'next' | 'prev';
  startedAt: number;
  targetPath: string | null;
};

type PendingFolderOpen = {
  token: number;
  startedAt: number;
  targetPath: string | null;
};

type CurrentImageTelemetry = {
  path: string | null;
  selectionKind: ImageSelectionKind | null;
  codecBackend: string | null;
  nativeDecodeSupported: boolean | null;
  selectedAt: number | null;
  previewVisibleMs: number | null;
  fullResolutionReadyMs: number | null;
  visibleSourceUpdatedMs: number | null;
};

type InternalTelemetryState = {
  enabled: boolean;
  appStartedAt: number;
  startupMetricRecorded: boolean;
  nextImageSelectionKind: ImageSelectionKind | null;
  currentImage: CurrentImageTelemetry;
  pendingFolderOpen: PendingFolderOpen | null;
  pendingNavigationKeydown: PendingNavigationKeydown | null;
  latencies: Record<TelemetryLatencyMetricKey, RollingLatencySummary>;
  counters: Record<CounterKey, number>;
  gauges: Record<GaugeKey, number>;
};

export interface TelemetryLatencySummarySnapshot {
  currentMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  sampleCount: number;
}

export interface TelemetryRateSnapshot {
  hits: number;
  misses: number;
  hitRate: number | null;
}

export interface PerformanceTelemetrySnapshot {
  enabled: boolean;
  currentImage: {
    path: string | null;
    selectionKind: ImageSelectionKind | null;
    codecBackend: string | null;
    nativeDecodeSupported: boolean | null;
    previewVisibleMs: number | null;
    fullResolutionReadyMs: number | null;
    visibleSourceUpdatedMs: number | null;
  };
  latencies: Record<TelemetryLatencyMetricKey, TelemetryLatencySummarySnapshot>;
  caches: {
    thumbnail: TelemetryRateSnapshot & {
      entries: number;
      estimatedBytes: number;
      budgetBytes: number;
    };
    previewAssets: TelemetryRateSnapshot & {
      entries: number;
      estimatedBytes: number;
      budgetBytes: number;
    };
    fullAssets: TelemetryRateSnapshot & { entries: number };
  };
  queues: {
    thumbnailQueueDepth: number;
    thumbnailInFlight: number;
    imageWorkQueueDepth: number;
    imageWorkActiveCount: number;
    imageWorkActiveInteractive: number;
    imageWorkActiveVisible: number;
    imageWorkActiveBackground: number;
    imageWorkDroppedQueued: number;
  };
}

export interface PerformanceTelemetrySpan {
  end: () => number | null;
  cancel: () => void;
}

function percentileFromSorted(values: number[], ratio: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * ratio)));
  return values[index] ?? null;
}

function computeRate(hits: number, misses: number): number | null {
  const total = hits + misses;
  if (total <= 0) {
    return null;
  }

  return hits / total;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function createCurrentImageState(): CurrentImageTelemetry {
  return {
    path: null,
    selectionKind: null,
    codecBackend: null,
    nativeDecodeSupported: null,
    selectedAt: null,
    previewVisibleMs: null,
    fullResolutionReadyMs: null,
    visibleSourceUpdatedMs: null,
  };
}

function createLatencySummaries(): Record<TelemetryLatencyMetricKey, RollingLatencySummary> {
  return {
    startupToFirstImageKnown: new RollingLatencySummary(LATENCY_HISTORY_LIMIT),
    imageSelectToPreviewVisible: new RollingLatencySummary(LATENCY_HISTORY_LIMIT),
    imageSelectToFullReady: new RollingLatencySummary(LATENCY_HISTORY_LIMIT),
    navigationKeydownToVisibleSourceUpdate: new RollingLatencySummary(LATENCY_HISTORY_LIMIT),
    folderOpenToFirstImageVisible: new RollingLatencySummary(LATENCY_HISTORY_LIMIT),
    folderScan: new RollingLatencySummary(LATENCY_HISTORY_LIMIT),
    previewGeneration: new RollingLatencySummary(LATENCY_HISTORY_LIMIT),
  };
}

function createCounterState(): Record<CounterKey, number> {
  return {
    thumbnailCacheHits: 0,
    thumbnailCacheMisses: 0,
    previewAssetCacheHits: 0,
    previewAssetCacheMisses: 0,
    fullAssetCacheHits: 0,
    fullAssetCacheMisses: 0,
  };
}

function createGaugeState(): Record<GaugeKey, number> {
  return {
    thumbnailQueueDepth: 0,
    thumbnailInFlight: 0,
    thumbnailCacheEntries: 0,
    thumbnailCacheEstimatedBytes: 0,
    thumbnailCacheBudgetBytes: 0,
    previewAssetCacheEntries: 0,
    previewAssetCacheEstimatedBytes: 0,
    previewAssetCacheBudgetBytes: 0,
    fullAssetCacheEntries: 0,
    imageWorkQueueDepth: 0,
    imageWorkActiveCount: 0,
    imageWorkActiveInteractive: 0,
    imageWorkActiveVisible: 0,
    imageWorkActiveBackground: 0,
    imageWorkDroppedQueued: 0,
  };
}

function createInitialState(): InternalTelemetryState {
  return {
    enabled: false,
    appStartedAt: now(),
    startupMetricRecorded: false,
    nextImageSelectionKind: null,
    currentImage: createCurrentImageState(),
    pendingFolderOpen: null,
    pendingNavigationKeydown: null,
    latencies: createLatencySummaries(),
    counters: createCounterState(),
    gauges: createGaugeState(),
  };
}

export class RollingLatencySummary {
  private readonly limit: number;
  private readonly samples: number[] = [];
  private nextIndex = 0;
  private currentMs: number | null = null;

  constructor(limit = LATENCY_HISTORY_LIMIT) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  record(durationMs: number): void {
    this.currentMs = durationMs;

    if (this.samples.length < this.limit) {
      this.samples.push(durationMs);
      return;
    }

    this.samples[this.nextIndex] = durationMs;
    this.nextIndex = (this.nextIndex + 1) % this.limit;
  }

  snapshot(): TelemetryLatencySummarySnapshot {
    if (this.samples.length === 0) {
      return {
        currentMs: this.currentMs,
        p50Ms: null,
        p95Ms: null,
        sampleCount: 0,
      };
    }

    const sorted = [...this.samples].sort((left, right) => left - right);
    return {
      currentMs: this.currentMs,
      p50Ms: percentileFromSorted(sorted, 0.5),
      p95Ms: percentileFromSorted(sorted, 0.95),
      sampleCount: this.samples.length,
    };
  }
}

const listeners = new Set<TelemetryListener>();
const activeSpans = new Map<number, ActiveSpan>();
let state = createInitialState();
let spanCounter = 0;
let snapshotDirty = true;
let cachedSnapshot: PerformanceTelemetrySnapshot = buildSnapshot();
let pendingNotifyHandle: number | null = null;

function buildSnapshot(): PerformanceTelemetrySnapshot {
  return {
    enabled: state.enabled,
    currentImage: {
      path: state.currentImage.path,
      selectionKind: state.currentImage.selectionKind,
      codecBackend: state.currentImage.codecBackend,
      nativeDecodeSupported: state.currentImage.nativeDecodeSupported,
      previewVisibleMs: state.currentImage.previewVisibleMs,
      fullResolutionReadyMs: state.currentImage.fullResolutionReadyMs,
      visibleSourceUpdatedMs: state.currentImage.visibleSourceUpdatedMs,
    },
    latencies: {
      startupToFirstImageKnown: state.latencies.startupToFirstImageKnown.snapshot(),
      imageSelectToPreviewVisible: state.latencies.imageSelectToPreviewVisible.snapshot(),
      imageSelectToFullReady: state.latencies.imageSelectToFullReady.snapshot(),
      navigationKeydownToVisibleSourceUpdate:
        state.latencies.navigationKeydownToVisibleSourceUpdate.snapshot(),
      folderOpenToFirstImageVisible: state.latencies.folderOpenToFirstImageVisible.snapshot(),
      folderScan: state.latencies.folderScan.snapshot(),
      previewGeneration: state.latencies.previewGeneration.snapshot(),
    },
    caches: {
      thumbnail: {
        hits: state.counters.thumbnailCacheHits,
        misses: state.counters.thumbnailCacheMisses,
        hitRate: computeRate(
          state.counters.thumbnailCacheHits,
          state.counters.thumbnailCacheMisses
        ),
        entries: state.gauges.thumbnailCacheEntries,
        estimatedBytes: state.gauges.thumbnailCacheEstimatedBytes,
        budgetBytes: state.gauges.thumbnailCacheBudgetBytes,
      },
      previewAssets: {
        hits: state.counters.previewAssetCacheHits,
        misses: state.counters.previewAssetCacheMisses,
        hitRate: computeRate(
          state.counters.previewAssetCacheHits,
          state.counters.previewAssetCacheMisses
        ),
        entries: state.gauges.previewAssetCacheEntries,
        estimatedBytes: state.gauges.previewAssetCacheEstimatedBytes,
        budgetBytes: state.gauges.previewAssetCacheBudgetBytes,
      },
      fullAssets: {
        hits: state.counters.fullAssetCacheHits,
        misses: state.counters.fullAssetCacheMisses,
        hitRate: computeRate(
          state.counters.fullAssetCacheHits,
          state.counters.fullAssetCacheMisses
        ),
        entries: state.gauges.fullAssetCacheEntries,
      },
    },
    queues: {
      thumbnailQueueDepth: state.gauges.thumbnailQueueDepth,
      thumbnailInFlight: state.gauges.thumbnailInFlight,
      imageWorkQueueDepth: state.gauges.imageWorkQueueDepth,
      imageWorkActiveCount: state.gauges.imageWorkActiveCount,
      imageWorkActiveInteractive: state.gauges.imageWorkActiveInteractive,
      imageWorkActiveVisible: state.gauges.imageWorkActiveVisible,
      imageWorkActiveBackground: state.gauges.imageWorkActiveBackground,
      imageWorkDroppedQueued: state.gauges.imageWorkDroppedQueued,
    },
  };
}

function markSnapshotDirty(): void {
  snapshotDirty = true;
  scheduleNotify();
}

function flushSnapshot(): void {
  if (!snapshotDirty) {
    return;
  }

  cachedSnapshot = buildSnapshot();
  snapshotDirty = false;
}

function scheduleNotify(): void {
  if (listeners.size === 0 || pendingNotifyHandle !== null) {
    return;
  }

  const notify = () => {
    pendingNotifyHandle = null;
    flushSnapshot();
    listeners.forEach((listener) => listener());
  };

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    pendingNotifyHandle = window.requestAnimationFrame(notify);
    return;
  }

  pendingNotifyHandle = window.setTimeout(notify, 16);
}

function recordLatency(metric: TelemetryLatencyMetricKey, durationMs: number): void {
  state.latencies[metric].record(durationMs);
  markSnapshotDirty();
}

function updateCounter(counter: CounterKey, amount: number): void {
  if (!state.enabled) {
    return;
  }

  state.counters[counter] += amount;
  markSnapshotDirty();
}

function updateGauge(gauge: GaugeKey, value: number): void {
  if (!state.enabled) {
    return;
  }

  state.gauges[gauge] = value;
  markSnapshotDirty();
}

function resetMutableMetrics(): void {
  state.latencies = createLatencySummaries();
  state.counters = createCounterState();
  state.gauges = createGaugeState();
  state.currentImage = createCurrentImageState();
  state.nextImageSelectionKind = null;
  state.pendingFolderOpen = null;
  state.pendingNavigationKeydown = null;
  activeSpans.clear();
}

function completeNavigationVisibleSource(path: string, durationMs: number): void {
  recordLatency('navigationKeydownToVisibleSourceUpdate', durationMs);
  if (state.currentImage.path === path) {
    state.currentImage.visibleSourceUpdatedMs = durationMs;
  }
  state.pendingNavigationKeydown = null;
}

const noopPerformanceTelemetrySpan: PerformanceTelemetrySpan = {
  end: () => null,
  cancel: () => {},
};

export function markPerformanceTelemetryAppStart(): void {
  state.appStartedAt = now();
}

export function setPerformanceTelemetryEnabled(enabled: boolean): void {
  if (state.enabled === enabled) {
    return;
  }

  state.enabled = enabled;
  markSnapshotDirty();
}

export function resetPerformanceTelemetry(): void {
  const startupMetricRecorded = state.startupMetricRecorded;
  resetMutableMetrics();
  state.startupMetricRecorded = startupMetricRecorded;
  markSnapshotDirty();
}

export function getPerformanceTelemetrySnapshot(): PerformanceTelemetrySnapshot {
  flushSnapshot();
  return cachedSnapshot;
}

function subscribePerformanceTelemetry(listener: TelemetryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePerformanceTelemetrySnapshot(): PerformanceTelemetrySnapshot {
  return useSyncExternalStore(
    subscribePerformanceTelemetry,
    getPerformanceTelemetrySnapshot,
    getPerformanceTelemetrySnapshot
  );
}

export function startPerformanceSpan(metric: TelemetryLatencyMetricKey): PerformanceTelemetrySpan {
  if (!state.enabled) {
    return noopPerformanceTelemetrySpan;
  }

  spanCounter += 1;
  const activeSpan: ActiveSpan = {
    key: spanCounter,
    metric,
    startedAt: now(),
    completed: false,
  };
  activeSpans.set(activeSpan.key, activeSpan);

  return {
    end: () => {
      const latest = activeSpans.get(activeSpan.key);
      if (!latest || latest.completed) {
        return null;
      }

      latest.completed = true;
      activeSpans.delete(activeSpan.key);
      const durationMs = now() - latest.startedAt;
      recordLatency(latest.metric, durationMs);
      return durationMs;
    },
    cancel: () => {
      activeSpans.delete(activeSpan.key);
    },
  };
}

export async function measurePerformanceSpan<T>(
  metric: TelemetryLatencyMetricKey,
  operation: () => Promise<T>
): Promise<T> {
  const span = startPerformanceSpan(metric);
  try {
    const result = await operation();
    span.end();
    return result;
  } catch (error) {
    span.cancel();
    throw error;
  }
}

function incrementPerformanceCounter(counter: CounterKey, amount = 1): void {
  updateCounter(counter, amount);
}

function setPerformanceGauge(gauge: GaugeKey, value: number): void {
  updateGauge(gauge, value);
}

export function setNextImageSelectionKind(kind: ImageSelectionKind): void {
  if (!state.enabled) {
    return;
  }

  state.nextImageSelectionKind = kind;
}

export function beginFolderOpenTelemetry(token = 0): void {
  if (!state.enabled) {
    return;
  }

  state.pendingFolderOpen = {
    token,
    startedAt: now(),
    targetPath: null,
  };
}

export function clearPendingFolderOpenTelemetry(token?: number): void {
  if (!state.pendingFolderOpen) {
    return;
  }

  if (token != null && state.pendingFolderOpen.token !== token) {
    return;
  }

  state.pendingFolderOpen = null;
}

export function beginNavigationKeydownTelemetry(direction: 'next' | 'prev'): void {
  if (!state.enabled) {
    return;
  }

  state.pendingNavigationKeydown = {
    direction,
    startedAt: now(),
    targetPath: null,
  };
  setNextImageSelectionKind(direction === 'next' ? 'keyboard-next' : 'keyboard-prev');
}

export function cancelPendingNavigationKeydownTelemetry(): void {
  state.pendingNavigationKeydown = null;
}

export function recordStartupFirstImageKnownTelemetry(): void {
  if (!state.enabled || state.startupMetricRecorded) {
    return;
  }

  state.startupMetricRecorded = true;
  recordLatency('startupToFirstImageKnown', now() - state.appStartedAt);
}

export function recordImageSelectedTelemetry(path: string): void {
  if (!state.enabled) {
    return;
  }

  const selectionKind = state.nextImageSelectionKind ?? 'other';

  if (state.currentImage.path === path) {
    if (state.pendingNavigationKeydown && !state.pendingNavigationKeydown.targetPath) {
      state.pendingNavigationKeydown.targetPath = path;
    }

    if (selectionKind === 'folder-open' && state.pendingFolderOpen) {
      state.nextImageSelectionKind = null;
      state.pendingFolderOpen.targetPath = path;
      state.currentImage = {
        path,
        selectionKind,
        codecBackend: null,
        nativeDecodeSupported: null,
        selectedAt: now(),
        previewVisibleMs: null,
        fullResolutionReadyMs: null,
        visibleSourceUpdatedMs: null,
      };
      markSnapshotDirty();
    }

    return;
  }

  state.nextImageSelectionKind = null;
  state.currentImage = {
    path,
    selectionKind,
    codecBackend: null,
    nativeDecodeSupported: null,
    selectedAt: now(),
    previewVisibleMs: null,
    fullResolutionReadyMs: null,
    visibleSourceUpdatedMs: null,
  };

  if (state.pendingNavigationKeydown) {
    state.pendingNavigationKeydown.targetPath = path;
  }

  if (selectionKind === 'folder-open' && state.pendingFolderOpen) {
    state.pendingFolderOpen.targetPath = path;
  }

  markSnapshotDirty();
}

export function recordImageCodecTelemetry(
  path: string,
  codecBackend: string,
  nativeDecodeSupported: boolean
): void {
  if (!state.enabled || state.currentImage.path !== path) {
    return;
  }

  state.currentImage.codecBackend = codecBackend;
  state.currentImage.nativeDecodeSupported = nativeDecodeSupported;
  markSnapshotDirty();
}

export function recordVisibleImageSourceUpdatedTelemetry(path: string): void {
  if (!state.enabled || !state.pendingNavigationKeydown) {
    return;
  }

  const { targetPath, startedAt } = state.pendingNavigationKeydown;
  if (targetPath && targetPath !== path) {
    return;
  }

  completeNavigationVisibleSource(path, now() - startedAt);
}

export function recordPreviewVisibleTelemetry(path: string): void {
  if (!state.enabled || state.currentImage.path !== path || state.currentImage.selectedAt == null) {
    return;
  }

  if (state.currentImage.previewVisibleMs != null) {
    return;
  }

  const durationMs = now() - state.currentImage.selectedAt;
  state.currentImage.previewVisibleMs = durationMs;
  recordLatency('imageSelectToPreviewVisible', durationMs);

  if (state.pendingFolderOpen?.targetPath === path) {
    recordLatency('folderOpenToFirstImageVisible', now() - state.pendingFolderOpen.startedAt);
    state.pendingFolderOpen = null;
  }
}

export function recordFullResolutionReadyTelemetry(path: string): void {
  if (!state.enabled || state.currentImage.path !== path || state.currentImage.selectedAt == null) {
    return;
  }

  if (state.currentImage.fullResolutionReadyMs != null) {
    return;
  }

  const durationMs = now() - state.currentImage.selectedAt;
  state.currentImage.fullResolutionReadyMs = durationMs;

  if (state.currentImage.previewVisibleMs == null) {
    state.currentImage.previewVisibleMs = durationMs;
    recordLatency('imageSelectToPreviewVisible', durationMs);
  }

  if (state.pendingFolderOpen?.targetPath === path) {
    recordLatency('folderOpenToFirstImageVisible', now() - state.pendingFolderOpen.startedAt);
    state.pendingFolderOpen = null;
  }

  recordLatency('imageSelectToFullReady', durationMs);
}

export function recordThumbnailCacheHit(): void {
  incrementPerformanceCounter('thumbnailCacheHits');
}

export function recordThumbnailCacheMiss(): void {
  incrementPerformanceCounter('thumbnailCacheMisses');
}

export function recordPreviewAssetCacheHit(): void {
  incrementPerformanceCounter('previewAssetCacheHits');
}

export function recordPreviewAssetCacheMiss(): void {
  incrementPerformanceCounter('previewAssetCacheMisses');
}

export function recordFullAssetCacheHit(): void {
  incrementPerformanceCounter('fullAssetCacheHits');
}

export function recordFullAssetCacheMiss(): void {
  incrementPerformanceCounter('fullAssetCacheMisses');
}

export function setThumbnailQueueDepthTelemetry(value: number): void {
  setPerformanceGauge('thumbnailQueueDepth', value);
}

export function setThumbnailInFlightTelemetry(value: number): void {
  setPerformanceGauge('thumbnailInFlight', value);
}

export function setThumbnailCacheEntryCountTelemetry(value: number): void {
  setPerformanceGauge('thumbnailCacheEntries', value);
}

export function setThumbnailCacheEstimatedBytesTelemetry(value: number): void {
  setPerformanceGauge('thumbnailCacheEstimatedBytes', value);
}

export function setThumbnailCacheBudgetBytesTelemetry(value: number): void {
  setPerformanceGauge('thumbnailCacheBudgetBytes', value);
}

export function setPreviewAssetCacheEntryCountTelemetry(value: number): void {
  setPerformanceGauge('previewAssetCacheEntries', value);
}

export function setPreviewAssetCacheEstimatedBytesTelemetry(value: number): void {
  setPerformanceGauge('previewAssetCacheEstimatedBytes', value);
}

export function setPreviewAssetCacheBudgetBytesTelemetry(value: number): void {
  setPerformanceGauge('previewAssetCacheBudgetBytes', value);
}

export function setFullAssetCacheEntryCountTelemetry(value: number): void {
  setPerformanceGauge('fullAssetCacheEntries', value);
}

export function setImageWorkQueueDepthTelemetry(value: number): void {
  setPerformanceGauge('imageWorkQueueDepth', value);
}

export function setImageWorkActiveCountTelemetry(value: number): void {
  setPerformanceGauge('imageWorkActiveCount', value);
}

export function setImageWorkActiveInteractiveTelemetry(value: number): void {
  setPerformanceGauge('imageWorkActiveInteractive', value);
}

export function setImageWorkActiveVisibleTelemetry(value: number): void {
  setPerformanceGauge('imageWorkActiveVisible', value);
}

export function setImageWorkActiveBackgroundTelemetry(value: number): void {
  setPerformanceGauge('imageWorkActiveBackground', value);
}

export function setImageWorkDroppedQueuedTelemetry(value: number): void {
  setPerformanceGauge('imageWorkDroppedQueued', value);
}

export function resetPerformanceTelemetryForTests(): void {
  state = createInitialState();
  activeSpans.clear();
  listeners.clear();
  spanCounter = 0;
  snapshotDirty = true;
  pendingNotifyHandle = null;
  cachedSnapshot = buildSnapshot();
}

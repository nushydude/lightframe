import { describe, expect, it, vi } from 'vitest';
import type { CodecHealthReport } from './tauriCommands';
import type { PerformanceTelemetrySnapshot } from './performanceTelemetry';
import { DEFAULT_SETTINGS } from '../types/settings';
import {
  buildDiagnosticsFileName,
  buildDiagnosticsSnapshot,
  serializeDiagnosticsSnapshot,
} from './diagnosticsSnapshot';

const codecHealth: CodecHealthReport = {
  platform: 'windows',
  entries: [
    {
      label: 'HEIF',
      extensions: ['heic', 'heif'],
      metadataBackend: 'windows_native',
      thumbnailBackend: 'windows_native',
      detailBackend: 'windows_native',
      nativeDecoderAvailable: true,
      nativeDecoderNames: ['HEIF Decoder'],
      nativeSupportedExtensions: ['heic', 'heif'],
      nativeMissingExtensions: [],
      nativeError: null,
      status: 'native-ready',
      note: 'Codec installed',
    },
  ],
  generatedCache: {
    buckets: [],
    totalFileCount: 0,
    totalSizeBytes: 0,
    rawNativeFailureCount: 0,
  },
  runtimeStats: {
    thumbnailCacheHits: 1,
    previewCacheHits: 2,
    tileCacheHits: 3,
    nativeThumbnailGenerations: 4,
    nativePreviewGenerations: 5,
    rustThumbnailGenerations: 6,
    rustPreviewGenerations: 7,
    placeholderThumbnailGenerations: 8,
    placeholderPreviewGenerations: 9,
    tileGenerations: 10,
  },
};

const telemetry: PerformanceTelemetrySnapshot = {
  enabled: true,
  currentImage: {
    path: 'C:/images/current.jpg',
    selectionKind: 'open-image',
    codecBackend: 'rust_image',
    nativeDecodeSupported: false,
    previewVisibleMs: 12,
    fullResolutionReadyMs: 24,
    visibleSourceUpdatedMs: 10,
  },
  latencies: {
    startupToFirstImageKnown: { currentMs: 1, p50Ms: 1, p95Ms: 1, sampleCount: 1 },
    imageSelectToPreviewVisible: { currentMs: 2, p50Ms: 2, p95Ms: 2, sampleCount: 1 },
    imageSelectToFullReady: { currentMs: 3, p50Ms: 3, p95Ms: 3, sampleCount: 1 },
    navigationKeydownToVisibleSourceUpdate: {
      currentMs: 4,
      p50Ms: 4,
      p95Ms: 4,
      sampleCount: 1,
    },
    folderOpenToFirstImageVisible: { currentMs: 5, p50Ms: 5, p95Ms: 5, sampleCount: 1 },
    folderIndexRead: { currentMs: 6, p50Ms: 6, p95Ms: 6, sampleCount: 1 },
    folderScan: { currentMs: 7, p50Ms: 7, p95Ms: 7, sampleCount: 1 },
    previewGeneration: { currentMs: 8, p50Ms: 8, p95Ms: 8, sampleCount: 1 },
    tileGeneration: { currentMs: 9, p50Ms: 9, p95Ms: 9, sampleCount: 1 },
  },
  caches: {
    thumbnail: { hits: 1, misses: 2, hitRate: 0.33, entries: 3, estimatedBytes: 4, budgetBytes: 5 },
    previewAssets: {
      hits: 6,
      misses: 7,
      hitRate: 0.46,
      entries: 8,
      estimatedBytes: 9,
      budgetBytes: 10,
    },
    fullAssets: { hits: 11, misses: 12, hitRate: 0.48, entries: 13 },
  },
  queues: {
    thumbnailQueueDepth: 1,
    thumbnailInFlight: 2,
    imageWorkQueueDepth: 3,
    imageWorkActiveCount: 4,
    imageWorkActiveInteractive: 5,
    imageWorkActiveVisible: 6,
    imageWorkActiveBackground: 7,
    imageWorkDroppedQueued: 8,
  },
};

describe('diagnosticsSnapshot', () => {
  it('builds a structured diagnostics snapshot with app, viewer, settings, and telemetry state', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('TestAgent/1.0');
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('en-AU');
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1.5);

    const snapshot = buildDiagnosticsSnapshot({
      settings: {
        ...DEFAULT_SETTINGS,
        performanceMode: 'fast',
        recentFolders: [{ path: 'C:/photos', label: 'photos', openedAt: 123 }],
      },
      viewer: {
        currentImagePath: 'C:/images/current.jpg',
        folderPath: 'C:/images',
        currentIndex: 4,
        visibleImageCount: 12,
        folderImageCount: 18,
        viewMode: 'viewer',
        zoomMode: 'fit',
        zoomLevel: 1,
        isFullscreen: false,
        isSlideshowActive: false,
        isFolderScanning: false,
        curationFilter: 'favorites',
        showPerformanceTelemetry: true,
      },
      codecHealth,
      telemetry,
      currentImageMetadata: {
        width: 4000,
        height: 3000,
        file_size_bytes: 1024,
        format: 'JPEG',
        rust_decode_supported: true,
      },
      windowLabel: 'main',
      collectedAt: new Date('2026-05-24T03:00:00.000Z'),
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.app.version).toBe('7.11.0');
    expect(snapshot.app.windowLabel).toBe('main');
    expect(snapshot.viewer.visibleImageCount).toBe(12);
    expect(snapshot.settings.performanceMode).toBe('fast');
    expect(snapshot.settings.recentFoldersCount).toBe(1);
    expect(snapshot.currentImageMetadata?.format).toBe('JPEG');
    expect(snapshot.codecHealth?.entries[0]?.label).toBe('HEIF');
    expect(snapshot.probeErrors).toEqual({});
    expect(snapshot.telemetry.latencies.tileGeneration.currentMs).toBe(9);
  });

  it('serializes snapshots as pretty JSON with a trailing newline', () => {
    const text = serializeDiagnosticsSnapshot(
      buildDiagnosticsSnapshot({
        settings: DEFAULT_SETTINGS,
        viewer: {
          currentImagePath: null,
          folderPath: null,
          currentIndex: -1,
          visibleImageCount: 0,
          folderImageCount: 0,
          viewMode: 'viewer',
          zoomMode: 'fit',
          zoomLevel: 1,
          isFullscreen: false,
          isSlideshowActive: false,
          isFolderScanning: false,
          curationFilter: 'all',
          showPerformanceTelemetry: false,
        },
        codecHealth,
        telemetry,
        currentImageMetadata: null,
        probeErrors: { currentImageMetadata: 'missing file' },
        windowLabel: 'secondary',
        collectedAt: new Date('2026-05-24T03:00:00.000Z'),
      })
    );

    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      app: { name: 'LightFrame' },
      viewer: { currentImagePath: null, viewMode: 'viewer' },
      currentImageMetadata: null,
      probeErrors: { currentImageMetadata: 'missing file' },
    });
  });

  it('builds a stable diagnostics file name', () => {
    expect(buildDiagnosticsFileName(new Date('2026-05-24T03:00:00.123Z'))).toBe(
      'lightframe-diagnostics-2026-05-24T03-00-00Z.json'
    );
  });
});

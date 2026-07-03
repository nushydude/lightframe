import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCanvas } from './ImageCanvas';
import { ViewerChrome } from './ViewerChrome';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { DEFAULT_SETTINGS } from '../types/settings';
import type { ImageMetadata } from '../types/image';

const {
  getPreviewAssetMock,
  requestFullAssetMock,
  preloadPreviewAssetMock,
  preloadFullAssetMock,
  trimImageAssetCacheMock,
  invalidateImageAssetMock,
  getImageMetadataMock,
  getImageTileMock,
  generatedImageAssetToUrlMock,
  telemetryMock,
  refreshProjectorStateMock,
} = vi.hoisted(() => ({
  getPreviewAssetMock: vi.fn(async () => 'asset://localhost/cache/preview.jpg?v=preview'),
  requestFullAssetMock: vi.fn(async () => 'asset://localhost/full.jpg?v=full'),
  preloadPreviewAssetMock: vi.fn(async () => undefined),
  preloadFullAssetMock: vi.fn(async () => undefined),
  trimImageAssetCacheMock: vi.fn(),
  invalidateImageAssetMock: vi.fn(),
  getImageMetadataMock: vi.fn<() => Promise<ImageMetadata>>(async () => ({
    width: 1200,
    height: 900,
    file_size_bytes: 1024,
    format: 'JPEG',
    codec_backend: 'rust_image',
    detail_backend: 'rust_image',
    detail_supported: true,
    native_decode_supported: false,
    rust_decode_supported: true,
  })),
  getImageTileMock: vi.fn(async () => ({
    file_path: 'C:/cache/tile.jpg',
    cache_key: 'tile',
    width: 512,
    height: 512,
  })),
  generatedImageAssetToUrlMock: vi.fn(
    (asset: { file_path: string; cache_key: string }) =>
      `asset://localhost/${asset.file_path}?v=${asset.cache_key}`
  ),
  telemetryMock: vi.fn(),
  refreshProjectorStateMock: vi.fn(),
}));

vi.mock('../services/imageAssetCache', () => ({
  getPreviewAsset: getPreviewAssetMock,
  requestFullAsset: requestFullAssetMock,
  preloadPreviewAsset: preloadPreviewAssetMock,
  preloadFullAsset: preloadFullAssetMock,
  trimImageAssetCache: trimImageAssetCacheMock,
  invalidateImageAsset: invalidateImageAssetMock,
}));

vi.mock('../services/imageWorkScheduler', () => ({
  IMAGE_WORK_PRIORITY: {
    currentPreview: 'current-preview',
    currentFull: 'current-full',
    currentMetadata: 'current-metadata',
    adjacentDirectional: 'adjacent-directional',
    visibleThumbnail: 'visible-thumbnail',
    backgroundPreload: 'background-preload',
  },
  imageWorkScheduler: {
    schedule: ({
      key,
      run,
    }: {
      key: string;
      run: (context: { signal: AbortSignal; key: string }) => unknown;
    }) => ({
      promise: Promise.resolve().then(() => run({ signal: new AbortController().signal, key })),
    }),
    cancelQueued: vi.fn(() => 0),
  },
}));

vi.mock('../services/tauriCommands', async () => {
  const actual = await vi.importActual('../services/tauriCommands');
  return {
    ...(actual as Record<string, unknown>),
    getImageMetadata: getImageMetadataMock,
    getImageTile: getImageTileMock,
    generatedImageAssetToUrl: generatedImageAssetToUrlMock,
  };
});

vi.mock('../services/performanceTelemetry', () => ({
  recordImageCodecTelemetry: telemetryMock,
  recordFullResolutionReadyTelemetry: telemetryMock,
  recordPreviewVisibleTelemetry: telemetryMock,
  recordVisibleImageSourceUpdatedTelemetry: telemetryMock,
  recordImageSelectedTelemetry: telemetryMock,
  measurePerformanceSpan: vi.fn(async (_metric: string, operation: () => Promise<unknown>) =>
    operation()
  ),
}));

vi.mock('../hooks/useProjectorState', () => ({
  useProjectorState: () => ({
    isProjectorOpen: false,
    refreshProjectorState: refreshProjectorStateMock,
  }),
}));

const chromeProps = {
  onOpenFile: vi.fn(),
  onOpenFolder: vi.fn(),
  onOpenRecentFolder: vi.fn(),
  onRefreshFolder: vi.fn(),
  onGoHome: vi.fn(),
  onFirst: vi.fn(),
  onNext: vi.fn(),
  onPrev: vi.fn(),
  onStartSlideshow: vi.fn(),
  onStopSlideshow: vi.fn(),
  onTogglePause: vi.fn(),
};

function openSingleImage(): void {
  useViewerStore.setState({
    currentImagePath: 'C:/Images/photo.jpg',
    currentIndex: 0,
    images: [
      {
        path: 'C:/Images/photo.jpg',
        file_name: 'photo.jpg',
        extension: 'jpg',
        size_bytes: 1024,
        modified_at: '1',
      },
    ],
    allImages: [
      {
        path: 'C:/Images/photo.jpg',
        file_name: 'photo.jpg',
        extension: 'jpg',
        size_bytes: 1024,
        modified_at: '1',
      },
    ],
    viewMode: 'viewer',
    zoomMode: 'fit',
    zoomLevel: 1,
    panX: 0,
    panY: 0,
  });
}

function getRenderedImage(): HTMLImageElement {
  const image = document.querySelector<HTMLImageElement>(
    '.image-canvas img:not(.image-full-loader)'
  );
  expect(image).toBeTruthy();
  return image as HTMLImageElement;
}

describe('single-image zoom integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    useViewerStore.getState().reset();
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...DEFAULT_SETTINGS,
        mouseWheelBehavior: 'zoom',
      },
    }));
    openSingleImage();
  });

  it('applies chrome and wheel zoom to the rendered single-image canvas', async () => {
    render(
      <>
        <ImageCanvas />
        <ViewerChrome {...chromeProps} />
      </>
    );

    await waitFor(() => expect(getRenderedImage()).toHaveClass('fit'));

    const zoomInButton = screen.getByLabelText('Zoom in');
    fireEvent.pointerDown(zoomInButton, { pointerType: 'mouse' });
    fireEvent.pointerUp(zoomInButton, { pointerType: 'mouse' });

    await waitFor(() => {
      const image = getRenderedImage();
      expect(image).toHaveClass('custom');
      expect(image.style.transform).toContain('scale(1.25)');
    });

    const canvas = document.querySelector<HTMLDivElement>('.image-canvas');
    expect(canvas).toBeTruthy();
    fireEvent.wheel(canvas as HTMLDivElement, { deltaY: -100 });

    await waitFor(() => {
      const image = getRenderedImage();
      expect(useViewerStore.getState().zoomLevel).toBeGreaterThan(1.25);
      expect(image.style.transform).toContain('scale(');
    });
  });
});

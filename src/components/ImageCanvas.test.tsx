import { act, fireEvent, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCanvas } from './ImageCanvas';
import { useViewerStore } from '../state/viewerStore';
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
  recordImageCodecTelemetryMock,
  recordFullResolutionReadyTelemetryMock,
  recordPreviewVisibleTelemetryMock,
  recordVisibleImageSourceUpdatedTelemetryMock,
  recordImageSelectedTelemetryMock,
  measurePerformanceSpanMock,
  isProjectorGrantOnlySessionMock,
  zoomPanState,
} = vi.hoisted(() => ({
  getPreviewAssetMock: vi.fn(async () => 'asset://localhost/cache/preview.jpg?v=preview'),
  requestFullAssetMock: vi.fn(async () => 'asset://localhost/full.jpg'),
  preloadPreviewAssetMock: vi.fn(async () => undefined),
  preloadFullAssetMock: vi.fn(async () => undefined),
  trimImageAssetCacheMock: vi.fn(),
  invalidateImageAssetMock: vi.fn(),
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
  recordImageCodecTelemetryMock: vi.fn(),
  getImageMetadataMock: vi.fn<() => Promise<ImageMetadata>>(async () => ({
    width: 1200,
    height: 900,
    file_size_bytes: 1024,
    format: 'JPEG',
    codec_backend: 'rust_image',
    native_decode_supported: false,
    detail_backend: 'rust_image',
    detail_supported: true,
    rust_decode_supported: true,
  })),
  recordFullResolutionReadyTelemetryMock: vi.fn(),
  recordPreviewVisibleTelemetryMock: vi.fn(),
  recordVisibleImageSourceUpdatedTelemetryMock: vi.fn(),
  recordImageSelectedTelemetryMock: vi.fn(),
  measurePerformanceSpanMock: vi.fn(async (_metric: string, operation: () => Promise<unknown>) =>
    operation()
  ),
  isProjectorGrantOnlySessionMock: vi.fn(() => false),
  zoomPanState: {
    zoomLevel: 1,
    panX: 0,
    panY: 0,
    isDragging: false,
  },
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
  },
}));

vi.mock('../services/tauriCommands', () => ({
  acknowledgeSessionAssetDeliveryResponses: vi.fn(async () => true),
  getImageMetadata: getImageMetadataMock,
  getImageTileById: getImageTileMock,
  generatedImageAssetToUrl: generatedImageAssetToUrlMock,
  releaseSessionAssetDelivery: vi.fn(async () => false),
  getActiveSessionForPath: vi.fn(() => ({ sessionId: 'sess_test', imageId: 'img_test' })),
  isProjectorGrantOnlySession: isProjectorGrantOnlySessionMock,
}));

vi.mock('../services/performanceTelemetry', () => ({
  recordImageCodecTelemetry: recordImageCodecTelemetryMock,
  recordFullResolutionReadyTelemetry: recordFullResolutionReadyTelemetryMock,
  recordPreviewVisibleTelemetry: recordPreviewVisibleTelemetryMock,
  recordVisibleImageSourceUpdatedTelemetry: recordVisibleImageSourceUpdatedTelemetryMock,
  recordImageSelectedTelemetry: recordImageSelectedTelemetryMock,
  measurePerformanceSpan: measurePerformanceSpanMock,
}));

vi.mock('../hooks/useZoomPan', () => ({
  useZoomPan: () => ({
    zoomMode: 'fit',
    zoomLevel: zoomPanState.zoomLevel,
    panX: zoomPanState.panX,
    panY: zoomPanState.panY,
    isDragging: zoomPanState.isDragging,
    handleMouseDown: vi.fn(),
    handleMouseMove: vi.fn(),
    handleMouseUp: vi.fn(),
  }),
}));

describe('ImageCanvas', () => {
  const originalImage = globalThis.Image;

  beforeEach(() => {
    vi.clearAllMocks();
    zoomPanState.zoomLevel = 1;
    zoomPanState.panX = 0;
    zoomPanState.panY = 0;
    zoomPanState.isDragging = false;
    isProjectorGrantOnlySessionMock.mockReturnValue(false);
    getPreviewAssetMock.mockImplementation(
      async () => 'asset://localhost/cache/preview.jpg?v=preview'
    );
    requestFullAssetMock.mockImplementation(async () => 'asset://localhost/full.jpg');
    getImageTileMock.mockImplementation(async () => ({
      file_path: 'C:/cache/tile.jpg',
      cache_key: 'tile',
      width: 512,
      height: 512,
    }));
    measurePerformanceSpanMock.mockImplementation(
      async (_metric: string, operation: () => Promise<unknown>) => operation()
    );
    generatedImageAssetToUrlMock.mockImplementation(
      (asset: { file_path: string; cache_key: string }) =>
        `asset://localhost/${asset.file_path}?v=${asset.cache_key}`
    );
    getImageMetadataMock.mockImplementation(async () => ({
      width: 1200,
      height: 900,
      file_size_bytes: 1024,
      format: 'JPEG',
      rust_decode_supported: true,
    }));
    vi.useFakeTimers();
    useViewerStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.Image = originalImage;
  });

  it('preloads adjacent images with preview intent by default', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 1,
      images: [
        {
          path: 'C:/images/prev.jpg',
          file_name: 'prev.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/next2.jpg',
          file_name: 'next2.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    render(<ImageCanvas />);

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(preloadPreviewAssetMock).toHaveBeenCalledTimes(3);
    expect(preloadFullAssetMock).not.toHaveBeenCalled();
  });

  it('does not issue adjacent media reads from a projector-grant-only renderer', async () => {
    isProjectorGrantOnlySessionMock.mockReturnValue(true);
    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      activeSessionId: null,
      images: [
        {
          id: 'img_current',
          sessionId: 'sess_projector',
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: null,
        },
        {
          id: 'img_next',
          sessionId: 'sess_projector',
          path: 'C:/images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: null,
        },
      ],
    });

    render(<ImageCanvas />);
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(preloadPreviewAssetMock).not.toHaveBeenCalled();
    expect(preloadFullAssetMock).not.toHaveBeenCalled();
  });

  it('retains full-folder cache entries while favorites-only navigation is filtered', async () => {
    const allImages = [
      {
        path: 'C:/images/hidden-a.jpg',
        file_name: 'hidden-a.jpg',
        extension: 'jpg',
        size_bytes: 1,
        modified_at: '1',
      },
      {
        path: 'C:/images/favorite.jpg',
        file_name: 'favorite.jpg',
        extension: 'jpg',
        size_bytes: 1,
        modified_at: '1',
      },
      {
        path: 'C:/images/hidden-b.jpg',
        file_name: 'hidden-b.jpg',
        extension: 'jpg',
        size_bytes: 1,
        modified_at: '1',
      },
    ];
    const visibleImages = [allImages[1]];
    const expectedRetentionPaths = allImages.map((image) => image.path).sort();

    useViewerStore.setState({
      currentImagePath: visibleImages[0].path,
      currentIndex: 0,
      images: visibleImages,
      allImages,
      showOnlyFavorites: true,
    });

    render(<ImageCanvas />);

    const folderPruneCall = trimImageAssetCacheMock.mock.calls.find(
      ([, maxEntries]) => maxEntries === Number.POSITIVE_INFINITY
    );
    expect(Array.from(folderPruneCall?.[0] as Set<string>).sort()).toEqual(expectedRetentionPaths);
    expect(folderPruneCall?.[2]).toMatchObject({ pruneMissing: true });

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    const navigationTrimCall = trimImageAssetCacheMock.mock.calls.find(([, maxEntries]) =>
      Number.isFinite(maxEntries as number)
    );
    const navigationTrimOptions = navigationTrimCall?.[2] as
      | { pruneMissingPaths?: Set<string>; cancelOutsidePaths?: Set<string> }
      | undefined;
    expect(Array.from(navigationTrimOptions?.pruneMissingPaths ?? []).sort()).toEqual(
      expectedRetentionPaths
    );
    expect(Array.from(navigationTrimOptions?.cancelOutsidePaths ?? []).sort()).toEqual(
      expectedRetentionPaths
    );
  });

  it('prioritizes leading adjacent preloads in the current navigation direction', async () => {
    const images = Array.from({ length: 7 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: '1',
    }));

    useViewerStore.setState({
      currentImagePath: images[2].path,
      currentIndex: 2,
      images,
    });

    render(<ImageCanvas />);

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    preloadPreviewAssetMock.mockClear();

    await act(async () => {
      useViewerStore.getState().setCurrentIndex(3);
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    const callsByPath = new Map(
      (
        preloadPreviewAssetMock.mock.calls as unknown as Array<
          [string | { path: string }, number, { priority?: string } | undefined]
        >
      ).map(([target, , options]) => [typeof target === 'string' ? target : target.path, options])
    );

    expect(callsByPath.get(images[4].path)).toMatchObject({
      priority: 'adjacent-directional',
    });
    expect(callsByPath.get(images[5].path)).toMatchObject({
      priority: 'adjacent-directional',
    });
    const backgroundPreviewCall = callsByPath.get(images[2].path);
    const backgroundFullCall = (
      preloadFullAssetMock.mock.calls as unknown as Array<
        [string, { priority?: string } | undefined]
      >
    ).find(([path]) => path === images[2].path)?.[1];

    expect(backgroundPreviewCall ?? backgroundFullCall).toMatchObject({
      priority: 'background-preload',
    });
  });

  it('skips stale same-folder preload writes and trims after fast navigation', async () => {
    const images = Array.from({ length: 6 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: '1',
    }));

    const oldDeferredResolves: Array<() => void> = [];
    const oldCanStoreGuards: Array<() => boolean> = [];
    let phase: 'old' | 'new' = 'old';

    preloadPreviewAssetMock.mockImplementation((async (
      _path: string,
      _maxDimension: number,
      options?: { canStore?: () => boolean }
    ) => {
      if (phase === 'old') {
        if (options?.canStore) {
          oldCanStoreGuards.push(options.canStore);
        }
        await new Promise<void>((resolve) => {
          oldDeferredResolves.push(resolve);
        });
        return;
      }
    }) as unknown as () => Promise<undefined>);

    useViewerStore.setState({
      currentImagePath: images[1].path,
      currentIndex: 1,
      images,
    });

    render(<ImageCanvas />);

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(oldDeferredResolves.length).toBeGreaterThan(0);

    await act(async () => {
      useViewerStore.getState().setCurrentIndex(3);
      await Promise.resolve();
    });
    phase = 'new';

    for (const guard of oldCanStoreGuards) {
      expect(guard()).toBe(false);
    }

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    const keepWindowCallsBeforeOldResolve = trimImageAssetCacheMock.mock.calls.filter(
      ([, maxEntries]) => Number.isFinite(maxEntries as number)
    );
    expect(keepWindowCallsBeforeOldResolve).toHaveLength(1);
    expect(Array.from(keepWindowCallsBeforeOldResolve[0][0] as Set<string>).sort()).toEqual(
      [images[2].path, images[3].path, images[4].path, images[5].path].sort()
    );

    for (const resolve of oldDeferredResolves) {
      resolve();
    }

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const keepWindowCallsAfterOldResolve = trimImageAssetCacheMock.mock.calls.filter(
      ([, maxEntries]) => Number.isFinite(maxEntries as number)
    );
    expect(keepWindowCallsAfterOldResolve).toHaveLength(1);
    expect(Array.from(keepWindowCallsAfterOldResolve[0][0] as Set<string>).sort()).toEqual(
      [images[2].path, images[3].path, images[4].path, images[5].path].sort()
    );
  });

  it('surfaces full asset URL creation failures instead of staying stuck loading', async () => {
    requestFullAssetMock.mockImplementationOnce(async () => {
      throw new Error('convert failed');
    });
    getPreviewAssetMock.mockImplementationOnce(() => new Promise(() => {}));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(requestFullAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'C:/images/current.jpg' }),
      expect.anything()
    );
    expect(useViewerStore.getState().errorMessage).toContain('Could not create image URL');

    consoleErrorSpy.mockRestore();
  });

  it('renders the full asset when preview rendering stalls', async () => {
    getPreviewAssetMock.mockImplementationOnce(() => new Promise(() => {}));
    getImageMetadataMock.mockResolvedValueOnce({
      width: 4000,
      height: 3000,
      file_size_bytes: 1024,
      format: 'JPEG',
      rust_decode_supported: true,
    });

    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }
    globalThis.Image = FakeImage as unknown as typeof Image;

    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
      await Promise.resolve();
    });

    const previewImage = container.querySelector('img');
    expect(previewImage).not.toBeNull();
    expect(previewImage?.getAttribute('src')).toBe('asset://localhost/full.jpg');

    await act(async () => {
      fireEvent.error(previewImage as HTMLImageElement);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'C:/images/current.jpg' }),
      expect.anything()
    );
    expect(useViewerStore.getState().errorMessage).toContain('Could not display image');
  });

  it('loads the full asset after React StrictMode remount checks', async () => {
    getPreviewAssetMock.mockImplementation(() => new Promise(() => {}));

    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(
      <StrictMode>
        <ImageCanvas />
      </StrictMode>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'C:/images/current.jpg' }),
      expect.anything()
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/full.jpg');
  });

  it('does not record visible-source telemetry from a stale prior image during navigation', async () => {
    getPreviewAssetMock.mockImplementation((async (target: string | { path: string }) => {
      const path = typeof target === 'string' ? target : target.path;
      if (path === 'C:/images/next.jpg') {
        return new Promise<string>(() => {});
      }

      return 'asset://localhost/cache/current-preview.jpg?v=current';
    }) as unknown as () => Promise<string>);
    requestFullAssetMock.mockImplementation((async (target: string | { path: string }) => {
      const p = typeof target === 'string' ? target : target.path;
      return p === 'C:/images/next.jpg'
        ? 'asset://localhost/next-full.jpg'
        : 'asset://localhost/current-full.jpg';
    }) as unknown as () => Promise<string>);

    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    recordVisibleImageSourceUpdatedTelemetryMock.mockClear();

    await act(async () => {
      useViewerStore.getState().setCurrentImage('C:/images/next.jpg', 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recordVisibleImageSourceUpdatedTelemetryMock).toHaveBeenCalledTimes(1);
    expect(recordVisibleImageSourceUpdatedTelemetryMock).toHaveBeenCalledWith('C:/images/next.jpg');
  });

  it('ignores stale prior-image load events after navigation until the next source loads', async () => {
    getPreviewAssetMock.mockImplementation((async (target: string | { path: string }) => {
      const path = typeof target === 'string' ? target : target.path;
      if (path === 'C:/images/next.jpg') {
        return new Promise<string>(() => {});
      }

      return 'asset://localhost/cache/current-preview.jpg?v=current';
    }) as unknown as () => Promise<string>);
    requestFullAssetMock.mockImplementation((async (target: string | { path: string }) => {
      const p = typeof target === 'string' ? target : target.path;
      return p === 'C:/images/next.jpg'
        ? 'asset://localhost/next-full.jpg'
        : 'asset://localhost/current-full.jpg';
    }) as unknown as () => Promise<string>);

    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const visibleImage = container.querySelector('img:not(.image-full-loader)');
    const fullLoaderImage = container.querySelector('img.image-full-loader');
    expect(visibleImage?.getAttribute('src')).toBe(
      'asset://localhost/cache/current-preview.jpg?v=current'
    );

    recordPreviewVisibleTelemetryMock.mockClear();
    recordFullResolutionReadyTelemetryMock.mockClear();

    await act(async () => {
      useViewerStore.getState().setCurrentImage('C:/images/next.jpg', 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('img:not(.image-full-loader)')?.getAttribute('src')).toBe(
      'asset://localhost/next-full.jpg'
    );

    await act(async () => {
      fireEvent.load(visibleImage as HTMLImageElement);
      fireEvent.load(fullLoaderImage as HTMLImageElement);
      await Promise.resolve();
    });

    expect(recordPreviewVisibleTelemetryMock).not.toHaveBeenCalledWith('C:/images/next.jpg');
    expect(recordFullResolutionReadyTelemetryMock).not.toHaveBeenCalledWith('C:/images/next.jpg');
  });

  it('ignores stale prior-image full asset errors after navigation', async () => {
    getPreviewAssetMock.mockImplementation((async (target: string | { path: string }) => {
      const path = typeof target === 'string' ? target : target.path;
      return path === 'C:/images/next.jpg'
        ? 'asset://localhost/cache/next-preview.jpg?v=next'
        : 'asset://localhost/cache/current-preview.jpg?v=current';
    }) as unknown as () => Promise<string>);
    requestFullAssetMock.mockImplementation((async (target: string | { path: string }) => {
      const p = typeof target === 'string' ? target : target.path;
      return p === 'C:/images/next.jpg'
        ? 'asset://localhost/next-full.jpg'
        : 'asset://localhost/current-full.jpg';
    }) as unknown as () => Promise<string>);

    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const staleFullLoader = container.querySelector('img.image-full-loader');
    expect(staleFullLoader?.getAttribute('src')).toBe('asset://localhost/current-full.jpg');

    await act(async () => {
      useViewerStore.getState().setCurrentImage('C:/images/next.jpg', 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.error(staleFullLoader as HTMLImageElement);
      await Promise.resolve();
    });

    expect(useViewerStore.getState().currentImagePath).toBe('C:/images/next.jpg');
    expect(useViewerStore.getState().errorMessage).toBeNull();
  });

  it('keeps the preview visible when the full asset cannot render', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const visibleImage = container.querySelector('img:not(.image-full-loader)');
    const fullLoader = container.querySelector('img.image-full-loader');

    expect(visibleImage?.getAttribute('src')).toBe('asset://localhost/cache/preview.jpg?v=preview');
    expect(fullLoader?.getAttribute('src')).toBe('asset://localhost/full.jpg');

    await act(async () => {
      fireEvent.error(fullLoader as HTMLImageElement);
      await Promise.resolve();
    });

    expect(container.querySelector('img:not(.image-full-loader)')?.getAttribute('src')).toBe(
      'asset://localhost/cache/preview.jpg?v=preview'
    );
    expect(useViewerStore.getState().errorMessage).toBeNull();
  });

  it('uses the full asset immediately when preview generation stalls', async () => {
    getPreviewAssetMock.mockImplementationOnce(() => new Promise(() => {}));

    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }
    globalThis.Image = FakeImage as unknown as typeof Image;

    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'C:/images/current.jpg' }),
      expect.anything()
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/full.jpg');
  });

  it('uses tiles instead of a full asset for deep-zoom huge JPEGs', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: 1000,
          height: 800,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect
    );
    zoomPanState.zoomLevel = 1.5;
    getImageMetadataMock.mockResolvedValueOnce({
      width: 12_000,
      height: 8_000,
      file_size_bytes: 48_000_000,
      format: 'JPEG',
      rust_decode_supported: true,
    });

    useViewerStore.setState({
      currentImagePath: 'C:/images/huge.jpg',
      currentIndex: 0,
      zoomMode: 'custom',
      images: [
        {
          path: 'C:/images/huge.jpg',
          file_name: 'huge.jpg',
          extension: 'jpg',
          size_bytes: 48_000_000,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).not.toHaveBeenCalled();
    expect(container.querySelector('.tiled-image-renderer')).not.toBeNull();
    expect(getImageTileMock).toHaveBeenCalled();

    rectSpy.mockRestore();
  });

  it('uses native tiled detail for large HEIC images with Windows codec support', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: 1000,
          height: 800,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect
    );
    zoomPanState.zoomLevel = 1.5;
    getImageMetadataMock.mockResolvedValueOnce({
      width: 12_000,
      height: 8_000,
      file_size_bytes: 48_000_000,
      format: 'HEIC',
      codec_backend: 'windows_native',
      native_decode_supported: true,
      detail_backend: 'windows_native',
      detail_supported: true,
      rust_decode_supported: false,
    });

    useViewerStore.setState({
      currentImagePath: 'C:/images/huge.heic',
      currentIndex: 0,
      zoomMode: 'custom',
      images: [
        {
          path: 'C:/images/huge.heic',
          file_name: 'huge.heic',
          extension: 'heic',
          size_bytes: 48_000_000,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).not.toHaveBeenCalled();
    expect(container.querySelector('.tiled-image-renderer')).not.toBeNull();
    expect(getImageTileMock).toHaveBeenCalled();

    rectSpy.mockRestore();
  });

  it('keeps zoomed-out huge JPEGs on the preview path', async () => {
    zoomPanState.zoomLevel = 0.1;
    getImageMetadataMock.mockResolvedValueOnce({
      width: 20_000,
      height: 16_000,
      file_size_bytes: 80_000_000,
      format: 'JPEG',
      rust_decode_supported: true,
    });

    useViewerStore.setState({
      currentImagePath: 'C:/images/huge.jpg',
      currentIndex: 0,
      zoomMode: 'custom',
      images: [
        {
          path: 'C:/images/huge.jpg',
          file_name: 'huge.jpg',
          extension: 'jpg',
          size_bytes: 80_000_000,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.tiled-image-renderer')).toBeNull();
    expect(getImageTileMock).not.toHaveBeenCalled();
    expect(requestFullAssetMock).not.toHaveBeenCalled();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'asset://localhost/cache/preview.jpg?v=preview'
    );
  });

  it('keeps oversized non-JPEG images on the preview path during deep zoom', async () => {
    zoomPanState.zoomLevel = 1.5;
    getImageMetadataMock.mockResolvedValueOnce({
      width: 20_000,
      height: 12_000,
      file_size_bytes: 180_000_000,
      format: 'TIFF',
      rust_decode_supported: true,
    });

    useViewerStore.setState({
      currentImagePath: 'C:/images/huge.tif',
      currentIndex: 0,
      zoomMode: 'custom',
      images: [
        {
          path: 'C:/images/huge.tif',
          file_name: 'huge.tif',
          extension: 'tif',
          size_bytes: 180_000_000,
          modified_at: '1',
        },
      ],
    });

    const { container } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).not.toHaveBeenCalled();
    expect(getImageTileMock).not.toHaveBeenCalled();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'asset://localhost/cache/preview.jpg?v=preview'
    );
    expect(useViewerStore.getState().errorMessage).toContain('Full-resolution zoom is limited');

    await act(async () => {
      fireEvent.load(container.querySelector('img') as HTMLImageElement);
      await Promise.resolve();
    });

    expect(useViewerStore.getState().errorMessage).toContain('Full-resolution zoom is limited');
  });

  it('does not use stale previous-image metadata to authorize full-resolution loads', async () => {
    zoomPanState.zoomLevel = 1.5;
    let resolveHugeMetadata:
      | ((metadata: Awaited<ReturnType<typeof getImageMetadataMock>>) => void)
      | null = null;
    getImageMetadataMock
      .mockResolvedValueOnce({
        width: 1200,
        height: 900,
        file_size_bytes: 1024,
        format: 'JPEG',
        rust_decode_supported: true,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveHugeMetadata = resolve;
          })
      );

    const firstImage = {
      path: 'C:/images/small.jpg',
      file_name: 'small.jpg',
      extension: 'jpg',
      size_bytes: 1,
      modified_at: '1',
    };
    const secondImage = {
      path: 'C:/images/huge.tif',
      file_name: 'huge.tif',
      extension: 'tif',
      size_bytes: 180_000_000,
      modified_at: '1',
    };

    useViewerStore.setState({
      currentImagePath: firstImage.path,
      currentIndex: 0,
      zoomMode: 'custom',
      images: [firstImage, secondImage],
    });

    render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: firstImage.path }),
      expect.anything()
    );
    requestFullAssetMock.mockClear();

    await act(async () => {
      useViewerStore.getState().setCurrentImage(secondImage.path, 1);
      useViewerStore.getState().setZoomLevel(1.5);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveHugeMetadata?.({
        width: 20_000,
        height: 12_000,
        file_size_bytes: 180_000_000,
        format: 'TIFF',
        rust_decode_supported: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().errorMessage).toContain('Full-resolution zoom is limited');
  });

  it('falls back to the browser asset when a safe native-codec preview is unavailable', async () => {
    getPreviewAssetMock.mockRejectedValueOnce(new Error('native preview unavailable'));
    getImageMetadataMock.mockResolvedValueOnce({
      width: 4000,
      height: 3000,
      file_size_bytes: 12_000_000,
      format: 'HEIC',
      rust_decode_supported: false,
    });

    useViewerStore.setState({
      currentImagePath: 'C:/images/native.heic',
      currentIndex: 0,
      images: [
        {
          path: 'C:/images/native.heic',
          file_name: 'native.heic',
          extension: 'heic',
          size_bytes: 12_000_000,
          modified_at: '1',
        },
      ],
    });

    render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'C:/images/native.heic' }),
      expect.anything()
    );
  });

  it('falls back to the full asset when safe tiled decoding fails', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: 1000,
          height: 800,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    zoomPanState.zoomLevel = 1.5;
    getImageTileMock.mockRejectedValueOnce(new Error('tile decode failed'));
    getImageMetadataMock.mockResolvedValueOnce({
      width: 8000,
      height: 6000,
      file_size_bytes: 48_000_000,
      format: 'JPEG',
      rust_decode_supported: true,
    });

    useViewerStore.setState({
      currentImagePath: 'C:/images/huge.jpg',
      currentIndex: 0,
      zoomMode: 'custom',
      images: [
        {
          path: 'C:/images/huge.jpg',
          file_name: 'huge.jpg',
          extension: 'jpg',
          size_bytes: 48_000_000,
          modified_at: '1',
        },
      ],
    });

    render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getImageTileMock).toHaveBeenCalled();
    expect(requestFullAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'C:/images/huge.jpg' }),
      expect.anything()
    );

    warnSpy.mockRestore();
    rectSpy.mockRestore();
  });

  it('keeps oversized JPEGs on preview when tiled decoding fails', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: 1000,
          height: 800,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    zoomPanState.zoomLevel = 1.5;
    getImageTileMock.mockRejectedValueOnce(new Error('tile decode failed'));
    getImageMetadataMock.mockResolvedValueOnce({
      width: 12_000,
      height: 8_000,
      file_size_bytes: 96_000_000,
      format: 'JPEG',
      rust_decode_supported: true,
    });

    useViewerStore.setState({
      currentImagePath: 'C:/images/oversized.jpg',
      currentIndex: 0,
      zoomMode: 'custom',
      images: [
        {
          path: 'C:/images/oversized.jpg',
          file_name: 'oversized.jpg',
          extension: 'jpg',
          size_bytes: 96_000_000,
          modified_at: '1',
        },
      ],
    });

    render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getImageTileMock).toHaveBeenCalled();
    expect(requestFullAssetMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().errorMessage).toContain('Full-resolution zoom is limited');

    warnSpy.mockRestore();
    rectSpy.mockRestore();
  });
});

import { act, fireEvent, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCanvas } from './ImageCanvas';
import { useViewerStore } from '../state/viewerStore';

const {
  getPreviewAssetMock,
  requestFullAssetMock,
  preloadPreviewAssetMock,
  preloadFullAssetMock,
  trimImageAssetCacheMock,
  invalidateImageAssetMock,
  getImageMetadataMock,
  recordFullResolutionReadyTelemetryMock,
  recordPreviewVisibleTelemetryMock,
  recordVisibleImageSourceUpdatedTelemetryMock,
  recordImageSelectedTelemetryMock,
} = vi.hoisted(() => ({
  getPreviewAssetMock: vi.fn(async () => 'asset://localhost/cache/preview.jpg?v=preview'),
  requestFullAssetMock: vi.fn(async () => 'asset://localhost/full.jpg'),
  preloadPreviewAssetMock: vi.fn(async () => undefined),
  preloadFullAssetMock: vi.fn(async () => undefined),
  trimImageAssetCacheMock: vi.fn(),
  invalidateImageAssetMock: vi.fn(),
  getImageMetadataMock: vi.fn(async () => ({
    width: 1200,
    height: 900,
    file_size_bytes: 1024,
    format: 'JPEG',
  })),
  recordFullResolutionReadyTelemetryMock: vi.fn(),
  recordPreviewVisibleTelemetryMock: vi.fn(),
  recordVisibleImageSourceUpdatedTelemetryMock: vi.fn(),
  recordImageSelectedTelemetryMock: vi.fn(),
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
  getImageMetadata: getImageMetadataMock,
}));

vi.mock('../services/performanceTelemetry', () => ({
  recordFullResolutionReadyTelemetry: recordFullResolutionReadyTelemetryMock,
  recordPreviewVisibleTelemetry: recordPreviewVisibleTelemetryMock,
  recordVisibleImageSourceUpdatedTelemetry: recordVisibleImageSourceUpdatedTelemetryMock,
  recordImageSelectedTelemetry: recordImageSelectedTelemetryMock,
}));

vi.mock('../hooks/useZoomPan', () => ({
  useZoomPan: () => ({
    zoomMode: 'fit',
    zoomLevel: 1,
    panX: 0,
    panY: 0,
    isDragging: false,
    handleMouseDown: vi.fn(),
    handleMouseMove: vi.fn(),
    handleMouseUp: vi.fn(),
  }),
}));

describe('ImageCanvas', () => {
  const originalImage = globalThis.Image;

  beforeEach(() => {
    vi.clearAllMocks();
    getPreviewAssetMock.mockImplementation(
      async () => 'asset://localhost/cache/preview.jpg?v=preview'
    );
    requestFullAssetMock.mockImplementation(async () => 'asset://localhost/full.jpg');
    getImageMetadataMock.mockImplementation(async () => ({
      width: 1200,
      height: 900,
      file_size_bytes: 1024,
      format: 'JPEG',
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
          [string, number, { priority?: string } | undefined]
        >
      ).map(([path, _maxDimension, options]) => [path, options])
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
    expect(requestFullAssetMock).toHaveBeenCalledWith('C:/images/current.jpg', expect.anything());
    expect(useViewerStore.getState().errorMessage).toContain('Could not create image URL');

    consoleErrorSpy.mockRestore();
  });

  it('renders the full asset immediately so preview rendering cannot block display', async () => {
    getPreviewAssetMock.mockImplementationOnce(() => new Promise(() => {}));
    getImageMetadataMock.mockResolvedValueOnce({
      width: 4000,
      height: 3000,
      file_size_bytes: 1024,
      format: 'JPEG',
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

    const previewImage = container.querySelector('img');
    expect(previewImage).not.toBeNull();
    expect(previewImage?.getAttribute('src')).toBe('asset://localhost/full.jpg');

    await act(async () => {
      fireEvent.error(previewImage as HTMLImageElement);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestFullAssetMock).toHaveBeenCalledWith('C:/images/current.jpg', expect.anything());
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

    expect(requestFullAssetMock).toHaveBeenCalledWith('C:/images/current.jpg', expect.anything());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/full.jpg');
  });

  it('does not record visible-source telemetry from a stale prior image during navigation', async () => {
    getPreviewAssetMock.mockImplementation((async (path: string) => {
      if (path === 'C:/images/next.jpg') {
        return new Promise<string>(() => {});
      }

      return 'asset://localhost/cache/current-preview.jpg?v=current';
    }) as unknown as () => Promise<string>);
    requestFullAssetMock.mockImplementation((async (path: string) => {
      return path === 'C:/images/next.jpg'
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
    getPreviewAssetMock.mockImplementation((async (path: string) => {
      if (path === 'C:/images/next.jpg') {
        return new Promise<string>(() => {});
      }

      return 'asset://localhost/cache/current-preview.jpg?v=current';
    }) as unknown as () => Promise<string>);
    requestFullAssetMock.mockImplementation((async (path: string) => {
      return path === 'C:/images/next.jpg'
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

    expect(requestFullAssetMock).toHaveBeenCalledWith('C:/images/current.jpg', expect.anything());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/full.jpg');
  });
});

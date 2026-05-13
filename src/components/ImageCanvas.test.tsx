import { act, fireEvent, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCanvas } from './ImageCanvas';
import { useViewerStore } from '../state/viewerStore';

const {
  getPreviewAssetMock,
  getFullAssetMock,
  preloadPreviewAssetMock,
  preloadFullAssetMock,
  trimImageAssetCacheMock,
  invalidateImageAssetMock,
  getImageMetadataMock,
} = vi.hoisted(() => ({
  getPreviewAssetMock: vi.fn(async () => 'asset://localhost/cache/preview.jpg?v=preview'),
  getFullAssetMock: vi.fn(() => 'asset://localhost/full.jpg'),
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
}));

vi.mock('../services/imageAssetCache', () => ({
  getPreviewAsset: getPreviewAssetMock,
  getFullAsset: getFullAssetMock,
  preloadPreviewAsset: preloadPreviewAssetMock,
  preloadFullAsset: preloadFullAssetMock,
  trimImageAssetCache: trimImageAssetCacheMock,
  invalidateImageAsset: invalidateImageAssetMock,
}));

vi.mock('../services/tauriCommands', () => ({
  getImageMetadata: getImageMetadataMock,
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
    getFullAssetMock.mockImplementation(() => 'asset://localhost/full.jpg');
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
    expect(Array.from(keepWindowCallsBeforeOldResolve[0][0] as Set<string>)).toEqual([
      images[1].path,
      images[2].path,
      images[3].path,
      images[4].path,
      images[5].path,
    ]);

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
    expect(Array.from(keepWindowCallsAfterOldResolve[0][0] as Set<string>)).toEqual([
      images[1].path,
      images[2].path,
      images[3].path,
      images[4].path,
      images[5].path,
    ]);
  });

  it('surfaces full asset URL creation failures instead of staying stuck loading', async () => {
    getFullAssetMock.mockImplementationOnce(() => {
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
    expect(getFullAssetMock).toHaveBeenCalledWith('C:/images/current.jpg');
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

    expect(getFullAssetMock).toHaveBeenCalledWith('C:/images/current.jpg');
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

    expect(getFullAssetMock).toHaveBeenCalledWith('C:/images/current.jpg');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/full.jpg');
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

    expect(getFullAssetMock).toHaveBeenCalledWith('C:/images/current.jpg');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/full.jpg');
  });
});

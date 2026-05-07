import { act, render } from '@testing-library/react';
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
  getPreviewAssetMock: vi.fn(async () => 'data:image/jpeg;base64,preview'),
  getFullAssetMock: vi.fn(async () => 'asset://localhost/full.jpg'),
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
        { path: 'C:/images/prev.jpg', file_name: 'prev.jpg', extension: 'jpg', size_bytes: 1, modified_at: '1' },
        { path: 'C:/images/current.jpg', file_name: 'current.jpg', extension: 'jpg', size_bytes: 1, modified_at: '1' },
        { path: 'C:/images/next.jpg', file_name: 'next.jpg', extension: 'jpg', size_bytes: 1, modified_at: '1' },
        { path: 'C:/images/next2.jpg', file_name: 'next2.jpg', extension: 'jpg', size_bytes: 1, modified_at: '1' },
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

  it('does not warn when full preloader resolves after unmount', async () => {
    const createdImages: Array<{ onload: (() => void) | null; onerror: (() => void) | null }> = [];

    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        createdImages.push({ onload: this.onload, onerror: this.onerror });
      }
    }
    globalThis.Image = FakeImage as unknown as typeof Image;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    useViewerStore.setState({
      currentImagePath: 'C:/images/current.jpg',
      currentIndex: 0,
      images: [
        { path: 'C:/images/current.jpg', file_name: 'current.jpg', extension: 'jpg', size_bytes: 1, modified_at: '1' },
      ],
    });

    const { unmount } = render(<ImageCanvas />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createdImages.length).toBeGreaterThan(0);

    unmount();

    await act(async () => {
      createdImages[0]?.onload?.();
      await Promise.resolve();
    });

    const unmountedWarning = consoleErrorSpy.mock.calls.some(([firstArg]) =>
      String(firstArg).includes("state update on an unmounted component")
    );
    expect(unmountedWarning).toBe(false);

    consoleErrorSpy.mockRestore();
  });
});

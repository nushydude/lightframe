import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageWorkScheduler } from '../services/imageWorkScheduler';
import type { ImageMetadata } from '../types/image';
import { TiledImageRenderer } from './TiledImageRenderer';

const { cancelMediaRequestMock, getImageTileMock, generatedImageAssetToUrlMock } = vi.hoisted(
  () => ({
    cancelMediaRequestMock: vi.fn().mockResolvedValue(false),
    getImageTileMock: vi.fn(),
    generatedImageAssetToUrlMock: vi.fn(
      (asset: { file_path: string; cache_key: string }) =>
        `asset://localhost/${asset.file_path}?v=${asset.cache_key}`
    ),
  })
);

vi.mock('../services/tauriCommands', () => ({
  cancelMediaRequest: cancelMediaRequestMock,
  getActiveSessionForPath: () => ({ sessionId: 'sess_1', imageId: 'img_1' }),
  getImageTileById: getImageTileMock,
  generatedImageAssetToUrl: generatedImageAssetToUrlMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function metadata(): ImageMetadata {
  return {
    width: 12_000,
    height: 8_000,
    file_size_bytes: 48_000_000,
    format: 'JPEG',
    rust_decode_supported: true,
  };
}

function Harness({ panX }: { panX: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={containerRef}>
      <TiledImageRenderer
        containerRef={containerRef}
        filePath="C:/images/huge.jpg"
        metadata={metadata()}
        previewSrc="asset://localhost/preview.jpg"
        zoomMode="custom"
        zoomLevel={1.5}
        panX={panX}
        panY={0}
        onPreviewLoad={vi.fn()}
        onPreviewError={vi.fn()}
        onTileError={vi.fn()}
      />
    </div>
  );
}

describe('TiledImageRenderer', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getImageTileMock.mockImplementation(() => createDeferred().promise);
    imageWorkScheduler.resetForTests();
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
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
  });

  afterEach(() => {
    rectSpy.mockRestore();
    imageWorkScheduler.resetForTests();
  });

  it('does not restart identical tile work while panning inside the same tile window', async () => {
    const { rerender } = render(<Harness panX={0} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getImageTileMock).toHaveBeenCalledTimes(2);

    rerender(<Harness panX={10} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getImageTileMock).toHaveBeenCalledTimes(2);
  });
});

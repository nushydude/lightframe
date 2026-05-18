import { describe, expect, it } from 'vitest';
import type { ImageMetadata } from '../types/image';
import {
  getTiledImageLayout,
  getVisibleTileRequests,
  isTiledRendererCandidate,
  shouldDeferFullResolutionForTiledCandidate,
  shouldUseTiledRenderer,
  TILE_SIZE,
} from './tiledRenderer';

function metadata(width: number, height: number): ImageMetadata {
  return {
    width,
    height,
    file_size_bytes: 32_000_000,
    format: 'JPEG',
    rust_decode_supported: true,
  };
}

describe('tiled renderer helpers', () => {
  it('chooses tiled rendering only for deep-zoom large JPEGs', () => {
    const large = metadata(12_000, 8_000);

    expect(isTiledRendererCandidate(large, 'C:/photos/pano.jpg')).toBe(true);
    expect(isTiledRendererCandidate(large, 'C:/photos/pano.png')).toBe(false);
    expect(isTiledRendererCandidate(metadata(4_000, 3_000), 'C:/photos/normal.jpg')).toBe(false);

    expect(
      shouldUseTiledRenderer({
        metadata: large,
        filePath: 'C:/photos/pano.jpg',
        zoomMode: 'fit',
        zoomLevel: 1,
        rotation: 0,
        isCropMode: false,
        hasPendingCropPreview: false,
      })
    ).toBe(false);

    expect(
      shouldUseTiledRenderer({
        metadata: large,
        filePath: 'C:/photos/pano.jpg',
        zoomMode: 'custom',
        zoomLevel: 1.5,
        rotation: 0,
        isCropMode: false,
        hasPendingCropPreview: false,
      })
    ).toBe(true);

    expect(
      shouldUseTiledRenderer({
        metadata: large,
        filePath: 'C:/photos/pano.jpg',
        zoomMode: 'custom',
        zoomLevel: 0.1,
        rotation: 0,
        isCropMode: false,
        hasPendingCropPreview: false,
      })
    ).toBe(false);
    expect(
      shouldDeferFullResolutionForTiledCandidate({
        metadata: large,
        filePath: 'C:/photos/pano.jpg',
        zoomMode: 'custom',
        zoomLevel: 0.1,
        rotation: 0,
        isCropMode: false,
        hasPendingCropPreview: false,
      })
    ).toBe(true);
  });

  it('keeps rotated and crop-preview images on the standard renderer', () => {
    const large = metadata(12_000, 8_000);
    const base = {
      metadata: large,
      filePath: 'C:/photos/pano.jpg',
      zoomMode: 'actual' as const,
      zoomLevel: 1,
      isCropMode: false,
      hasPendingCropPreview: false,
    };

    expect(shouldUseTiledRenderer({ ...base, rotation: 90 })).toBe(false);
    expect(shouldUseTiledRenderer({ ...base, rotation: 0, isCropMode: true })).toBe(false);
    expect(shouldUseTiledRenderer({ ...base, rotation: 0, hasPendingCropPreview: true })).toBe(
      false
    );
  });

  it('computes visible tiles from the current viewport and pan', () => {
    const layout = getTiledImageLayout({
      metadata: metadata(4_000, 3_000),
      containerWidth: 1_000,
      containerHeight: 800,
      zoomMode: 'custom',
      zoomLevel: 1,
      panX: -1_000,
      panY: -700,
    });

    const requests = getVisibleTileRequests({
      layout,
      containerWidth: 1_000,
      containerHeight: 800,
      tileSize: TILE_SIZE,
      preloadMargin: 0,
    });

    expect(requests.map((request) => request.key)).toEqual([
      '4:3',
      '5:3',
      '6:3',
      '4:4',
      '5:4',
      '6:4',
      '4:5',
      '5:5',
      '6:5',
    ]);
  });

  it('clips edge tile dimensions to the source image bounds', () => {
    const layout = getTiledImageLayout({
      metadata: metadata(1_100, 900),
      containerWidth: 1_100,
      containerHeight: 900,
      zoomMode: 'actual',
      zoomLevel: 1,
      panX: 0,
      panY: 0,
    });

    const requests = getVisibleTileRequests({
      layout,
      containerWidth: 1_100,
      containerHeight: 900,
      tileSize: TILE_SIZE,
      preloadMargin: 0,
    });
    const edge = requests.find((request) => request.key === '2:1');

    expect(edge).toMatchObject({
      width: 76,
      height: 388,
    });
  });

  it('caps over-large visible windows to the nearest tile requests', () => {
    const layout = getTiledImageLayout({
      metadata: metadata(20_000, 16_000),
      containerWidth: 5_000,
      containerHeight: 4_000,
      zoomMode: 'custom',
      zoomLevel: 1,
      panX: 0,
      panY: 0,
    });

    const requests = getVisibleTileRequests({
      layout,
      containerWidth: 5_000,
      containerHeight: 4_000,
      tileSize: TILE_SIZE,
      preloadMargin: 1,
    });

    expect(requests).toHaveLength(64);
    expect(requests.map((request) => request.key)).toContain('19:15');
    expect(requests.map((request) => request.key)).toContain('20:16');
  });
});

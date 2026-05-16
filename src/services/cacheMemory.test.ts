import { describe, expect, it } from 'vitest';
import {
  estimateDecodedImageBytes,
  estimateObjectUrlBytes,
  estimatePreviewAssetBytes,
  estimateThumbnailAssetBytes,
} from './cacheMemory';

describe('cacheMemory', () => {
  it('estimates decoded image memory from width and height', () => {
    expect(estimateDecodedImageBytes(400, 300)).toBe(400 * 300 * 4);
  });

  it('accounts for object URL overhead separately from decoded pixels', () => {
    const shortUrl = estimateObjectUrlBytes('asset://a');
    const longUrl = estimateObjectUrlBytes('asset://a/very/long/path.jpg?v=token');

    expect(longUrl).toBeGreaterThan(shortUrl);
  });

  it('uses conservative fallback dimensions for unknown preview sizes', () => {
    expect(
      estimatePreviewAssetBytes({
        maxDimension: 2048,
        url: 'asset://preview.jpg',
      })
    ).toBeGreaterThanOrEqual(2048 * 2048 * 4);
  });

  it('uses fixed thumbnail fallback sizing when dimensions are unknown', () => {
    expect(
      estimateThumbnailAssetBytes({
        url: 'asset://thumb.jpg',
        fallbackSize: 160,
      })
    ).toBeGreaterThanOrEqual(160 * 160 * 4);
  });
});

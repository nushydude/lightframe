import { describe, expect, it } from 'vitest';
import {
  isLikelyLargeImage,
  PREVIEW_MAX_DIMENSION,
  shouldPreloadAdjacentFullResolution,
  shouldLoadFullResolutionImmediately,
  shouldRequestFullResolution,
} from './imagePreviewStrategy';

describe('imagePreviewStrategy', () => {
  it('treats missing dimensions as likely large', () => {
    expect(isLikelyLargeImage(null)).toBe(true);
    expect(isLikelyLargeImage({ width: null, height: 100, file_size_bytes: 1, format: 'JPEG' })).toBe(
      true
    );
  });

  it('detects large images when either dimension exceeds the preview bound', () => {
    expect(
      isLikelyLargeImage({
        width: PREVIEW_MAX_DIMENSION + 1,
        height: 1000,
        file_size_bytes: 1,
        format: 'JPEG',
      })
    ).toBe(true);
    expect(
      isLikelyLargeImage({
        width: 1000,
        height: PREVIEW_MAX_DIMENSION + 1,
        file_size_bytes: 1,
        format: 'JPEG',
      })
    ).toBe(true);
  });

  it('requests full resolution for actual/custom mode and zoom greater than 1', () => {
    expect(shouldRequestFullResolution('actual', 1)).toBe(true);
    expect(shouldRequestFullResolution('custom', 0.5)).toBe(true);
    expect(shouldRequestFullResolution('fit', 1.2)).toBe(true);
    expect(shouldRequestFullResolution('fit', 1)).toBe(false);
  });

  it('loads full resolution immediately for small images', () => {
    const smallImage = {
      width: 1200,
      height: 900,
      file_size_bytes: 100,
      format: 'JPEG',
    };

    expect(shouldLoadFullResolutionImmediately(smallImage, 'fit', 1)).toBe(true);
    expect(shouldLoadFullResolutionImmediately(smallImage, 'fill', 1)).toBe(true);
  });

  it('defers full resolution for large images until zoom requires detail', () => {
    const largeImage = {
      width: 6000,
      height: 4000,
      file_size_bytes: 100,
      format: 'JPEG',
    };

    expect(shouldLoadFullResolutionImmediately(largeImage, 'fit', 1)).toBe(false);
    expect(shouldLoadFullResolutionImmediately(largeImage, 'actual', 1)).toBe(true);
    expect(shouldLoadFullResolutionImmediately(largeImage, 'fit', 1.3)).toBe(true);
  });

  it('preloads adjacent full resolution only when metadata confirms a small image', () => {
    const smallImage = {
      width: 1024,
      height: 768,
      file_size_bytes: 100,
      format: 'JPEG',
    };
    const largeImage = {
      width: PREVIEW_MAX_DIMENSION + 100,
      height: 1200,
      file_size_bytes: 100,
      format: 'JPEG',
    };

    expect(shouldPreloadAdjacentFullResolution(null)).toBe(false);
    expect(shouldPreloadAdjacentFullResolution(largeImage)).toBe(false);
    expect(shouldPreloadAdjacentFullResolution(smallImage)).toBe(true);
  });
});

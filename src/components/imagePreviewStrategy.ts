import type { ZoomMode } from '../state/viewerStore';
import type { ImageMetadata } from '../types/image';

export const PREVIEW_MAX_DIMENSION = 2048;

export function isLikelyLargeImage(
  metadata: ImageMetadata | null,
  maxDimension = PREVIEW_MAX_DIMENSION
): boolean {
  if (metadata?.width == null || metadata?.height == null) {
    return true;
  }

  return metadata.width > maxDimension || metadata.height > maxDimension;
}

export function shouldRequestFullResolution(zoomMode: ZoomMode, zoomLevel: number): boolean {
  return zoomMode === 'actual' || zoomMode === 'custom' || zoomLevel > 1;
}

export function shouldLoadFullResolutionImmediately(
  metadata: ImageMetadata | null,
  zoomMode: ZoomMode,
  zoomLevel: number,
  maxDimension = PREVIEW_MAX_DIMENSION
): boolean {
  if (shouldRequestFullResolution(zoomMode, zoomLevel)) {
    return true;
  }

  return !isLikelyLargeImage(metadata, maxDimension);
}

export function shouldPreloadAdjacentFullResolution(
  metadata: ImageMetadata | null,
  maxDimension = PREVIEW_MAX_DIMENSION
): boolean {
  if (!metadata) {
    return false;
  }

  return !isLikelyLargeImage(metadata, maxDimension);
}

import type { ZoomMode } from '../state/viewerStore';
import type { ImageMetadata } from '../types/image';

export const PREVIEW_MAX_DIMENSION = 2048;
const DIRECT_FULL_RESOLUTION_MAX_PIXELS = 80_000_000;
const DIRECT_FULL_RESOLUTION_MAX_DIMENSION = 16_384;

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

export function canRequestFullResolutionSafely(metadata: ImageMetadata | null): boolean {
  if (metadata?.browser_renderable === false) {
    return false;
  }

  if (metadata == null || metadata.width == null || metadata.height == null) {
    return true;
  }

  const pixels = metadata.width * metadata.height;
  return (
    pixels <= DIRECT_FULL_RESOLUTION_MAX_PIXELS &&
    metadata.width <= DIRECT_FULL_RESOLUTION_MAX_DIMENSION &&
    metadata.height <= DIRECT_FULL_RESOLUTION_MAX_DIMENSION
  );
}

export function getFullResolutionSafetyMessage(metadata: ImageMetadata | null): string | null {
  if (canRequestFullResolutionSafely(metadata)) {
    return null;
  }

  const dimensions =
    metadata != null && metadata.width != null && metadata.height != null
      ? ` (${metadata.width}x${metadata.height})`
      : '';
  const format = metadata?.format ? `${metadata.format} ` : '';
  return `Full-resolution zoom is limited for this ${format}image${dimensions}. LightFrame is showing the generated preview to avoid a very large decode.`;
}

export function shouldLoadFullResolutionImmediately(
  metadata: ImageMetadata | null,
  zoomMode: ZoomMode,
  zoomLevel: number,
  maxDimension = PREVIEW_MAX_DIMENSION
): boolean {
  if (!canRequestFullResolutionSafely(metadata)) {
    return false;
  }

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

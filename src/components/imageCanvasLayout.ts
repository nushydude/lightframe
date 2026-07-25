import type { CSSProperties } from 'react';
import type { NormalizedCropRect } from '../services/cropMath';
import type { ImageMetadata } from '../types/image';
import type { ZoomMode } from '../state/viewerStore';
import { getPreviewClipPath } from './cropPreview';

export type ImageStyleOptions = {
  zoomMode: ZoomMode;
  panX: number;
  panY: number;
  rotation: number;
  zoomLevel: number;
  isFullResolutionReady: boolean;
  metadata: ImageMetadata | null;
  pendingCropPreview: NormalizedCropRect | null;
  isCropMode: boolean;
};

function getRotationTransform(rotation: number): string {
  return rotation !== 0 ? `rotate(${rotation}deg)` : '';
}

function applyZoomStyle(
  style: CSSProperties,
  {
    zoomMode,
    panX,
    panY,
    rotation,
    zoomLevel,
  }: Pick<ImageStyleOptions, 'zoomMode' | 'panX' | 'panY' | 'rotation' | 'zoomLevel'>
): void {
  const rotationStr = getRotationTransform(rotation);

  if (zoomMode === 'actual') {
    style.transform = `translate(${panX}px, ${panY}px) ${rotationStr}`;
    style.maxWidth = 'none';
    style.maxHeight = 'none';
    return;
  }

  if (zoomMode === 'custom') {
    style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel}) ${rotationStr}`;
    style.maxWidth = 'none';
    style.maxHeight = 'none';
    return;
  }

  if (zoomMode === 'fill') {
    style.width = '100%';
    style.height = '100%';
    style.objectFit = 'cover';
    style.transform = rotationStr;
    return;
  }

  style.transform = rotationStr;
  if (rotation === 90 || rotation === 270) {
    style.maxWidth = '100vh';
    style.maxHeight = '100vw';
  }
}

function applyPreviewDimensions(
  style: CSSProperties,
  {
    zoomMode,
    isFullResolutionReady,
    metadata,
  }: Pick<ImageStyleOptions, 'zoomMode' | 'isFullResolutionReady' | 'metadata'>
): void {
  const shouldPinPreviewSize =
    !isFullResolutionReady &&
    metadata?.width != null &&
    metadata?.height != null &&
    (zoomMode === 'actual' || zoomMode === 'custom');

  if (!shouldPinPreviewSize) return;

  style.width = `${metadata.width}px`;
  style.height = `${metadata.height}px`;
}

function applyCropPreviewStyle(
  style: CSSProperties,
  { pendingCropPreview, isCropMode }: Pick<ImageStyleOptions, 'pendingCropPreview' | 'isCropMode'>
): void {
  if (!pendingCropPreview || isCropMode) return;

  style.clipPath = getPreviewClipPath(pendingCropPreview);
  style.transformOrigin = 'center center';
}

/** Composes the image display style from zoom, metadata, and crop-preview state. */
export function getImageStyle(options: ImageStyleOptions): CSSProperties {
  const style: CSSProperties = {};
  applyZoomStyle(style, options);
  applyPreviewDimensions(style, options);
  applyCropPreviewStyle(style, options);
  return style;
}

export type ImageBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Returns the visible image rectangle, correcting letterbox offsets in fit mode. */
export function getRenderedImageBounds({
  containerRect,
  image,
  imageRect,
  metadata,
  zoomMode,
}: {
  containerRect: DOMRect;
  image: HTMLImageElement;
  imageRect: DOMRect;
  metadata: ImageMetadata | null;
  zoomMode: ZoomMode;
}): ImageBounds {
  const baseBounds = {
    left: imageRect.left - containerRect.left,
    top: imageRect.top - containerRect.top,
    width: imageRect.width,
    height: imageRect.height,
  };

  if (zoomMode !== 'fit') return baseBounds;

  const intrinsicWidth = image.naturalWidth || metadata?.width || 0;
  const intrinsicHeight = image.naturalHeight || metadata?.height || 0;
  if (
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0 ||
    imageRect.width <= 0 ||
    imageRect.height <= 0
  ) {
    return baseBounds;
  }

  const scale = Math.min(imageRect.width / intrinsicWidth, imageRect.height / intrinsicHeight);
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;

  return {
    left: baseBounds.left + (imageRect.width - width) / 2,
    top: baseBounds.top + (imageRect.height - height) / 2,
    width,
    height,
  };
}

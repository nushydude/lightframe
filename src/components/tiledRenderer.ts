import type { ZoomMode } from '../state/viewerStore';
import type { ImageMetadata } from '../types/image';

export const TILE_SIZE = 512;
const TILED_RENDERER_MIN_PIXELS = 48_000_000;
const TILED_RENDERER_MIN_DIMENSION = 9_000;
const TILED_RENDERER_MIN_CUSTOM_SCALE = 0.5;
const TILED_RENDERER_MAX_VISIBLE_TILES = 64;
const TILED_RENDERER_PRELOAD_MARGIN = 1;

type TiledRendererOptions = {
  metadata: ImageMetadata | null;
  filePath: string | null;
  zoomMode: ZoomMode;
  zoomLevel: number;
  rotation: number;
  isCropMode: boolean;
  hasPendingCropPreview: boolean;
};

export type TiledImageLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  sourceWidth: number;
  sourceHeight: number;
};

export type TileRequest = {
  key: string;
  tileX: number;
  tileY: number;
  sourceX: number;
  sourceY: number;
  width: number;
  height: number;
};

function pathExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = normalized.substring(normalized.lastIndexOf('/') + 1);
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.substring(dotIndex + 1).toLowerCase() : '';
}

function isJpegTileDecodeSupportedForPath(filePath: string | null): boolean {
  if (!filePath) {
    return false;
  }

  return pathExtension(filePath) === 'jpg' || pathExtension(filePath) === 'jpeg';
}

function isNativeTileDecodeSupportedForPath(
  metadata: ImageMetadata | null,
  filePath: string | null
): boolean {
  if (!filePath || !metadata?.detail_supported) {
    return false;
  }

  const extension = pathExtension(filePath);
  return (
    (extension === 'heic' || extension === 'heif') &&
    metadata.detail_backend === 'windows_native' &&
    metadata.native_decode_supported === true
  );
}

function isTileDecodeSupported(metadata: ImageMetadata | null, filePath: string | null): boolean {
  return (
    isJpegTileDecodeSupportedForPath(filePath) ||
    isNativeTileDecodeSupportedForPath(metadata, filePath)
  );
}

export function isTiledRendererCandidate(
  metadata: ImageMetadata | null,
  filePath: string | null
): boolean {
  const width = metadata?.width ?? 0;
  const height = metadata?.height ?? 0;
  if (width <= 0 || height <= 0 || !isTileDecodeSupported(metadata, filePath)) {
    return false;
  }

  return (
    width * height >= TILED_RENDERER_MIN_PIXELS ||
    width >= TILED_RENDERER_MIN_DIMENSION ||
    height >= TILED_RENDERER_MIN_DIMENSION
  );
}

export function shouldUseTiledRenderer({
  metadata,
  filePath,
  zoomMode,
  zoomLevel,
  rotation,
  isCropMode,
  hasPendingCropPreview,
}: TiledRendererOptions): boolean {
  if (rotation !== 0 || isCropMode || hasPendingCropPreview) {
    return false;
  }

  if (zoomMode !== 'actual' && zoomMode !== 'custom') {
    return false;
  }

  if (zoomMode === 'custom' && zoomLevel < TILED_RENDERER_MIN_CUSTOM_SCALE) {
    return false;
  }

  return isTiledRendererCandidate(metadata, filePath);
}

export function shouldDeferFullResolutionForTiledCandidate({
  metadata,
  filePath,
  zoomMode,
  zoomLevel,
  rotation,
  isCropMode,
  hasPendingCropPreview,
}: TiledRendererOptions): boolean {
  return (
    zoomMode === 'custom' &&
    zoomLevel < TILED_RENDERER_MIN_CUSTOM_SCALE &&
    rotation === 0 &&
    !isCropMode &&
    !hasPendingCropPreview &&
    isTiledRendererCandidate(metadata, filePath)
  );
}

export function getTiledImageLayout({
  metadata,
  containerWidth,
  containerHeight,
  zoomMode,
  zoomLevel,
  panX,
  panY,
}: {
  metadata: ImageMetadata | null;
  containerWidth: number;
  containerHeight: number;
  zoomMode: ZoomMode;
  zoomLevel: number;
  panX: number;
  panY: number;
}): TiledImageLayout | null {
  const sourceWidth = metadata?.width ?? 0;
  const sourceHeight = metadata?.height ?? 0;
  if (sourceWidth <= 0 || sourceHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return null;
  }

  const scale = zoomMode === 'actual' ? 1 : Math.max(0.01, zoomLevel);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    left: (containerWidth - width) / 2 + panX,
    top: (containerHeight - height) / 2 + panY,
    width,
    height,
    scale,
    sourceWidth,
    sourceHeight,
  };
}

function clampTileRangeStart(value: number, margin: number): number {
  return Math.max(0, Math.floor(value) - margin);
}

function clampTileRangeEnd(value: number, maxTileIndex: number, margin: number): number {
  return Math.min(maxTileIndex, Math.floor(value) + margin);
}

function tileRangeCount({
  startTileX,
  startTileY,
  endTileX,
  endTileY,
}: {
  startTileX: number;
  startTileY: number;
  endTileX: number;
  endTileY: number;
}): number {
  return (endTileX - startTileX + 1) * (endTileY - startTileY + 1);
}

function createTileRequests({
  layout,
  tileSize,
  startTileX,
  startTileY,
  endTileX,
  endTileY,
}: {
  layout: TiledImageLayout;
  tileSize: number;
  startTileX: number;
  startTileY: number;
  endTileX: number;
  endTileY: number;
}): TileRequest[] {
  const requests: TileRequest[] = [];

  for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
    for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
      const sourceX = tileX * tileSize;
      const sourceY = tileY * tileSize;
      const width = Math.min(tileSize, layout.sourceWidth - sourceX);
      const height = Math.min(tileSize, layout.sourceHeight - sourceY);
      requests.push({
        key: `${tileX}:${tileY}`,
        tileX,
        tileY,
        sourceX,
        sourceY,
        width,
        height,
      });
    }
  }

  return requests;
}

function nearestTileRequests({
  requests,
  maxTiles,
  sourceCenterX,
  sourceCenterY,
  tileSize,
}: {
  requests: TileRequest[];
  maxTiles: number;
  sourceCenterX: number;
  sourceCenterY: number;
  tileSize: number;
}): TileRequest[] {
  return [...requests]
    .sort((left, right) => {
      const leftCenterX = left.sourceX + Math.min(tileSize, left.width) / 2;
      const leftCenterY = left.sourceY + Math.min(tileSize, left.height) / 2;
      const rightCenterX = right.sourceX + Math.min(tileSize, right.width) / 2;
      const rightCenterY = right.sourceY + Math.min(tileSize, right.height) / 2;
      const leftDistance = (leftCenterX - sourceCenterX) ** 2 + (leftCenterY - sourceCenterY) ** 2;
      const rightDistance =
        (rightCenterX - sourceCenterX) ** 2 + (rightCenterY - sourceCenterY) ** 2;

      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      return left.tileY - right.tileY || left.tileX - right.tileX;
    })
    .slice(0, maxTiles)
    .sort((left, right) => left.tileY - right.tileY || left.tileX - right.tileX);
}

export function getVisibleTileRequests({
  layout,
  containerWidth,
  containerHeight,
  tileSize = TILE_SIZE,
  preloadMargin = TILED_RENDERER_PRELOAD_MARGIN,
}: {
  layout: TiledImageLayout | null;
  containerWidth: number;
  containerHeight: number;
  tileSize?: number;
  preloadMargin?: number;
}): TileRequest[] {
  if (!layout || tileSize <= 0) {
    return [];
  }

  const sourceLeft = Math.max(0, -layout.left / layout.scale);
  const sourceTop = Math.max(0, -layout.top / layout.scale);
  const sourceRight = Math.min(layout.sourceWidth, (containerWidth - layout.left) / layout.scale);
  const sourceBottom = Math.min(layout.sourceHeight, (containerHeight - layout.top) / layout.scale);

  if (sourceRight <= sourceLeft || sourceBottom <= sourceTop) {
    return [];
  }

  const maxTileX = Math.ceil(layout.sourceWidth / tileSize) - 1;
  const maxTileY = Math.ceil(layout.sourceHeight / tileSize) - 1;
  const startTileX = clampTileRangeStart(sourceLeft / tileSize, preloadMargin);
  const startTileY = clampTileRangeStart(sourceTop / tileSize, preloadMargin);
  const endTileX = clampTileRangeEnd((sourceRight - 1) / tileSize, maxTileX, preloadMargin);
  const endTileY = clampTileRangeEnd((sourceBottom - 1) / tileSize, maxTileY, preloadMargin);
  const tileCount = tileRangeCount({ startTileX, startTileY, endTileX, endTileY });
  if (tileCount <= TILED_RENDERER_MAX_VISIBLE_TILES) {
    return createTileRequests({
      layout,
      tileSize,
      startTileX,
      startTileY,
      endTileX,
      endTileY,
    });
  }

  const visibleStartTileX = clampTileRangeStart(sourceLeft / tileSize, 0);
  const visibleStartTileY = clampTileRangeStart(sourceTop / tileSize, 0);
  const visibleEndTileX = clampTileRangeEnd((sourceRight - 1) / tileSize, maxTileX, 0);
  const visibleEndTileY = clampTileRangeEnd((sourceBottom - 1) / tileSize, maxTileY, 0);
  const visibleRequests = createTileRequests({
    layout,
    tileSize,
    startTileX: visibleStartTileX,
    startTileY: visibleStartTileY,
    endTileX: visibleEndTileX,
    endTileY: visibleEndTileY,
  });
  if (visibleRequests.length <= TILED_RENDERER_MAX_VISIBLE_TILES) {
    return visibleRequests;
  }

  return nearestTileRequests({
    requests: visibleRequests,
    maxTiles: TILED_RENDERER_MAX_VISIBLE_TILES,
    sourceCenterX: (sourceLeft + sourceRight) / 2,
    sourceCenterY: (sourceTop + sourceBottom) / 2,
    tileSize,
  });
}

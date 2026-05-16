const BYTES_PER_PIXEL = 4;
const CACHE_ENTRY_BASE_OVERHEAD_BYTES = 512;
const OBJECT_URL_BASE_OVERHEAD_BYTES = 2_048;
const STRING_CHARACTER_BYTES = 2;

type ImageMemoryEstimate = {
  width?: number | null;
  height?: number | null;
  fallbackWidth: number;
  fallbackHeight: number;
};

// Cache budgets are best-effort decoded-pixel weights for app-retained image handles.
// The browser and Tauri asset protocol may keep their own resource caches independently.
function normalizeDimension(value: number | null | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null || value <= 0) {
    return Math.max(1, Math.floor(fallback));
  }

  return Math.max(1, Math.floor(value));
}

export function estimateDecodedImageBytes(width: number, height: number): number {
  return Math.max(1, Math.floor(width)) * Math.max(1, Math.floor(height)) * BYTES_PER_PIXEL;
}

export function estimateObjectUrlBytes(url: string | undefined): number {
  const normalizedUrl = url ?? '';
  return (
    OBJECT_URL_BASE_OVERHEAD_BYTES +
    normalizedUrl.length * STRING_CHARACTER_BYTES +
    CACHE_ENTRY_BASE_OVERHEAD_BYTES
  );
}

function estimateDecodedPixelWeightBytes({
  width,
  height,
  fallbackWidth,
  fallbackHeight,
}: ImageMemoryEstimate): number {
  const resolvedWidth = normalizeDimension(width, fallbackWidth);
  const resolvedHeight = normalizeDimension(height, fallbackHeight);
  return estimateDecodedImageBytes(resolvedWidth, resolvedHeight);
}

export function estimatePreviewAssetBytes(options: {
  maxDimension: number;
  url: string;
  width?: number | null;
  height?: number | null;
}): number {
  return (
    estimateDecodedPixelWeightBytes({
      width: options.width,
      height: options.height,
      fallbackWidth: options.maxDimension,
      fallbackHeight: options.maxDimension,
    }) + estimateObjectUrlBytes(options.url)
  );
}

export function estimateThumbnailAssetBytes(options: {
  url: string;
  width?: number | null;
  height?: number | null;
  fallbackSize?: number;
}): number {
  const fallbackSize = Math.max(1, Math.floor(options.fallbackSize ?? 160));
  return (
    estimateDecodedPixelWeightBytes({
      width: options.width,
      height: options.height,
      fallbackWidth: fallbackSize,
      fallbackHeight: fallbackSize,
    }) + estimateObjectUrlBytes(options.url)
  );
}

export function formatBytesForHumans(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded =
    value >= 100 || unitIndex === 0 || Number.isInteger(value)
      ? Math.round(value).toString()
      : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

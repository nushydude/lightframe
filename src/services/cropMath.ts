export type CropAspectRatioPreset = 'free' | '1:1' | '4:3' | '3:2' | '16:9';

export type NormalizedCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_NORMALIZED_SIZE = 0.02;
const MIN_PIXEL_SIZE = 12;

const EPSILON = 1e-6;

export function getAspectRatioValue(preset: CropAspectRatioPreset): number | null {
  if (preset === 'free') return null;
  const [w, h] = preset.split(':').map(Number);
  if (!w || !h) return null;
  return w / h;
}

export function normalizedToPixelRect(
  rect: NormalizedCropRect,
  width: number,
  height: number
): PixelRect {
  return {
    x: rect.x * width,
    y: rect.y * height,
    width: rect.width * width,
    height: rect.height * height,
  };
}

export function normalizedToIntegerPixelRect(
  rect: NormalizedCropRect,
  width: number,
  height: number
): PixelRect {
  const left = Math.max(0, Math.min(width - 1, Math.floor(rect.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(rect.y * height)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil((rect.x + rect.width) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil((rect.y + rect.height) * height)));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function pixelToNormalizedRect(
  rect: PixelRect,
  width: number,
  height: number
): NormalizedCropRect {
  return clampNormalizedRect({
    x: rect.x / width,
    y: rect.y / height,
    width: rect.width / width,
    height: rect.height / height,
  });
}

export function clampNormalizedRect(
  rect: NormalizedCropRect,
  minSize = MIN_NORMALIZED_SIZE
): NormalizedCropRect {
  const width = clamp(rect.width, minSize, 1);
  const height = clamp(rect.height, minSize, 1);
  const x = clamp(rect.x, 0, 1 - width);
  const y = clamp(rect.y, 0, 1 - height);
  return { x, y, width, height };
}

export function clampPixelRect(
  rect: PixelRect,
  boundsWidth: number,
  boundsHeight: number,
  minSize = MIN_PIXEL_SIZE
): PixelRect {
  const width = clamp(rect.width, minSize, boundsWidth);
  const height = clamp(rect.height, minSize, boundsHeight);
  const x = clamp(rect.x, 0, boundsWidth - width);
  const y = clamp(rect.y, 0, boundsHeight - height);
  return { x, y, width, height };
}

function nudgeCropRect(
  rect: NormalizedCropRect,
  deltaXPx: number,
  deltaYPx: number,
  imageWidth: number,
  imageHeight: number
): NormalizedCropRect {
  const deltaX = imageWidth > 0 ? deltaXPx / imageWidth : 0;
  const deltaY = imageHeight > 0 ? deltaYPx / imageHeight : 0;
  return clampNormalizedRect({
    ...rect,
    x: rect.x + deltaX,
    y: rect.y + deltaY,
  });
}

export function nudgeCropRectInDirection(
  rect: NormalizedCropRect,
  direction: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
  stepPx: number,
  imageWidth: number,
  imageHeight: number
) {
  if (direction === 'ArrowUp') {
    return nudgeCropRect(rect, 0, -stepPx, imageWidth, imageHeight);
  }
  if (direction === 'ArrowDown') {
    return nudgeCropRect(rect, 0, stepPx, imageWidth, imageHeight);
  }
  if (direction === 'ArrowLeft') {
    return nudgeCropRect(rect, -stepPx, 0, imageWidth, imageHeight);
  }
  return nudgeCropRect(rect, stepPx, 0, imageWidth, imageHeight);
}

export function resizeRectWithHandle(
  startRect: PixelRect,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  boundsWidth: number,
  boundsHeight: number,
  aspectRatio?: number | null
): PixelRect {
  let left = startRect.x;
  let right = startRect.x + startRect.width;
  let top = startRect.y;
  let bottom = startRect.y + startRect.height;

  if (handle.includes('e')) right += deltaX;
  if (handle.includes('w')) left += deltaX;
  if (handle.includes('s')) bottom += deltaY;
  if (handle.includes('n')) top += deltaY;

  if (right < left) [left, right] = [right, left];
  if (bottom < top) [top, bottom] = [bottom, top];

  let width = Math.max(MIN_PIXEL_SIZE, right - left);
  let height = Math.max(MIN_PIXEL_SIZE, bottom - top);

  if (aspectRatio && aspectRatio > 0) {
    const horizontal = handle.includes('e') || handle.includes('w');
    const vertical = handle.includes('n') || handle.includes('s');
    if (horizontal && vertical) {
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        height = width / aspectRatio;
      } else {
        width = height * aspectRatio;
      }
    } else if (horizontal) {
      height = width / aspectRatio;
    } else if (vertical) {
      width = height * aspectRatio;
    }

    if (handle.includes('w')) {
      left = right - width;
    } else {
      right = left + width;
    }

    if (handle.includes('n')) {
      top = bottom - height;
    } else {
      bottom = top + height;
    }
  }

  left = clamp(left, 0, boundsWidth - MIN_PIXEL_SIZE);
  top = clamp(top, 0, boundsHeight - MIN_PIXEL_SIZE);
  right = clamp(right, left + MIN_PIXEL_SIZE, boundsWidth);
  bottom = clamp(bottom, top + MIN_PIXEL_SIZE, boundsHeight);

  width = right - left;
  height = bottom - top;

  if (aspectRatio && aspectRatio > 0) {
    const desiredHeight = width / aspectRatio;
    if (desiredHeight <= boundsHeight + EPSILON) {
      height = Math.max(MIN_PIXEL_SIZE, desiredHeight);
      if (handle.includes('n')) {
        top = bottom - height;
      }
    } else {
      const desiredWidth = height * aspectRatio;
      width = Math.max(MIN_PIXEL_SIZE, desiredWidth);
      if (handle.includes('w')) {
        left = right - width;
      }
    }
    left = clamp(left, 0, boundsWidth - width);
    top = clamp(top, 0, boundsHeight - height);
  }

  return clampPixelRect(
    { x: left, y: top, width, height },
    boundsWidth,
    boundsHeight,
    MIN_PIXEL_SIZE
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

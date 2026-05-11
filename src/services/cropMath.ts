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

type RectEdges = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type RectSize = {
  width: number;
  height: number;
};

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
  const edges = clampResizeEdges(
    applyAspectRatioToEdges(
      getResizedEdges(startRect, handle, deltaX, deltaY),
      handle,
      deltaX,
      deltaY,
      aspectRatio
    ),
    boundsWidth,
    boundsHeight
  );

  const rect = fitAspectRatioWithinBounds(edges, handle, boundsWidth, boundsHeight, aspectRatio);

  return clampPixelRect(rect, boundsWidth, boundsHeight, MIN_PIXEL_SIZE);
}

function getResizedEdges(
  startRect: PixelRect,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number
): RectEdges {
  const edges = {
    left: startRect.x + (handle.includes('w') ? deltaX : 0),
    right: startRect.x + startRect.width + (handle.includes('e') ? deltaX : 0),
    top: startRect.y + (handle.includes('n') ? deltaY : 0),
    bottom: startRect.y + startRect.height + (handle.includes('s') ? deltaY : 0),
  };

  return normalizeEdges(edges);
}

function normalizeEdges(edges: RectEdges): RectEdges {
  return {
    left: Math.min(edges.left, edges.right),
    right: Math.max(edges.left, edges.right),
    top: Math.min(edges.top, edges.bottom),
    bottom: Math.max(edges.top, edges.bottom),
  };
}

function applyAspectRatioToEdges(
  edges: RectEdges,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  aspectRatio?: number | null
): RectEdges {
  if (!aspectRatio || aspectRatio <= 0) return edges;

  const size = getAspectRatioSize(edges, handle, deltaX, deltaY, aspectRatio);
  return anchorSizeToHandle(edges, size, handle);
}

function getAspectRatioSize(
  edges: RectEdges,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  aspectRatio: number
): RectSize {
  let width = Math.max(MIN_PIXEL_SIZE, edges.right - edges.left);
  let height = Math.max(MIN_PIXEL_SIZE, edges.bottom - edges.top);
  const horizontal = handle.includes('e') || handle.includes('w');
  const vertical = handle.includes('n') || handle.includes('s');

  if (horizontal && (!vertical || Math.abs(deltaX) > Math.abs(deltaY))) {
    height = width / aspectRatio;
  } else if (vertical) {
    width = height * aspectRatio;
  }

  return { width, height };
}

function anchorSizeToHandle(edges: RectEdges, size: RectSize, handle: ResizeHandle): RectEdges {
  return {
    left: handle.includes('w') ? edges.right - size.width : edges.left,
    right: handle.includes('w') ? edges.right : edges.left + size.width,
    top: handle.includes('n') ? edges.bottom - size.height : edges.top,
    bottom: handle.includes('n') ? edges.bottom : edges.top + size.height,
  };
}

function clampResizeEdges(edges: RectEdges, boundsWidth: number, boundsHeight: number): RectEdges {
  const left = clamp(edges.left, 0, boundsWidth - MIN_PIXEL_SIZE);
  const top = clamp(edges.top, 0, boundsHeight - MIN_PIXEL_SIZE);
  return {
    left,
    top,
    right: clamp(edges.right, left + MIN_PIXEL_SIZE, boundsWidth),
    bottom: clamp(edges.bottom, top + MIN_PIXEL_SIZE, boundsHeight),
  };
}

function fitAspectRatioWithinBounds(
  edges: RectEdges,
  handle: ResizeHandle,
  boundsWidth: number,
  boundsHeight: number,
  aspectRatio?: number | null
): PixelRect {
  let left = edges.left;
  let top = edges.top;
  let width = edges.right - edges.left;
  let height = edges.bottom - edges.top;

  if (!aspectRatio || aspectRatio <= 0) {
    return { x: left, y: top, width, height };
  }

  const desiredHeight = width / aspectRatio;
  if (desiredHeight <= boundsHeight + EPSILON) {
    height = Math.max(MIN_PIXEL_SIZE, desiredHeight);
    top = handle.includes('n') ? edges.bottom - height : top;
  } else {
    width = Math.max(MIN_PIXEL_SIZE, height * aspectRatio);
    left = handle.includes('w') ? edges.right - width : left;
  }

  return {
    x: clamp(left, 0, boundsWidth - width),
    y: clamp(top, 0, boundsHeight - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

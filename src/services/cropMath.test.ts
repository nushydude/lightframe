import { describe, expect, it } from 'vitest';
import {
  clampNormalizedRect,
  getAspectRatioValue,
  normalizedToIntegerPixelRect,
  normalizedToPixelRect,
  nudgeCropRectInDirection,
  pixelToNormalizedRect,
  resizeRectWithHandle,
} from './cropMath';

describe('cropMath', () => {
  it('converts normalized rectangles to pixel rectangles and back', () => {
    const normalized = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
    const pixelRect = normalizedToPixelRect(normalized, 1000, 500);

    expect(pixelRect).toEqual({ x: 100, y: 100, width: 500, height: 200 });
    expect(pixelToNormalizedRect(pixelRect, 1000, 500)).toEqual(normalized);
  });

  it('rounds normalized rectangles to in-bounds integer pixel rectangles', () => {
    expect(
      normalizedToIntegerPixelRect(
        { x: 0.3333, y: 0.1, width: 0.6667, height: 0.9 },
        301,
        199
      )
    ).toEqual({
      x: 100,
      y: 19,
      width: 201,
      height: 180,
    });
  });

  it('clamps rectangles within image bounds', () => {
    expect(
      clampNormalizedRect({ x: -0.2, y: 0.95, width: 1.3, height: 0.2 })
    ).toEqual({
      x: 0,
      y: 0.8,
      width: 1,
      height: 0.2,
    });
  });

  it('resizes rectangles while preserving aspect ratio', () => {
    const resized = resizeRectWithHandle(
      { x: 100, y: 100, width: 200, height: 100 },
      'se',
      80,
      20,
      800,
      600,
      getAspectRatioValue('16:9')
    );

    expect(Math.round((resized.width / resized.height) * 100) / 100).toBeCloseTo(1.78, 1);
    expect(resized.width).toBeGreaterThan(200);
    expect(resized.height).toBeGreaterThan(100);
  });

  it('nudges rectangles by image-pixel equivalents', () => {
    const nudged = nudgeCropRectInDirection(
      { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
      'ArrowRight',
      10,
      1000,
      500
    );

    expect(nudged.x).toBeCloseTo(0.11);
    expect(nudged.y).toBeCloseTo(0.1);
  });
});

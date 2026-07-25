import { describe, expect, it } from 'vitest';
import { getAdjacentPreloadPlan } from './imageCanvasPreload';

describe('getAdjacentPreloadPlan', () => {
  it('prioritizes the navigation direction and keeps the current image first', () => {
    expect(getAdjacentPreloadPlan(3, 8, 'forward', 2, 2)).toEqual({
      keepIndices: [3, 4, 5, 6, 2],
      preloadIndices: [4, 5, 6, 2],
      leadingIndices: new Set([4, 5, 6]),
    });
  });

  it('does not queue the current image or indexes outside the folder', () => {
    const plan = getAdjacentPreloadPlan(0, 2, 'backward', 3, 3);

    expect(plan.keepIndices).toEqual([0, 1]);
    expect(plan.preloadIndices).toEqual([1]);
    expect(plan.leadingIndices).toEqual(new Set());
  });
});

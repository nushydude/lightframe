import { describe, expect, it } from 'vitest';
import { isInteractiveTargetOutsideGrid } from './keyboardTarget';

describe('isInteractiveTargetOutsideGrid', () => {
  it('guards controls and inputs but permits grid cells', () => {
    const root = document.createElement('div');
    const grid = document.createElement('div');
    const cell = document.createElement('button');
    const toolbar = document.createElement('button');
    const input = document.createElement('input');
    grid.append(cell);
    root.append(grid, toolbar, input);

    expect(isInteractiveTargetOutsideGrid(toolbar, grid)).toBe(true);
    expect(isInteractiveTargetOutsideGrid(input, grid)).toBe(true);
    expect(isInteractiveTargetOutsideGrid(cell, grid)).toBe(false);
    expect(isInteractiveTargetOutsideGrid(root, grid)).toBe(false);
  });
});

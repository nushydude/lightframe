import { describe, expect, it } from 'vitest';
import { selectRangePaths, toggleSelectionPath } from './contactSheetSelection';

describe('contactSheetSelection', () => {
  it('toggles a single path in the selection', () => {
    expect(toggleSelectionPath([], 'a')).toEqual(['a']);
    expect(toggleSelectionPath(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('adds an inclusive range of paths to the selection', () => {
    const images = [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }];

    expect(selectRangePaths(images, 1, 3, ['a'])).toEqual(['a', 'b', 'c', 'd']);
    expect(selectRangePaths(images, 3, 1, [])).toEqual(['b', 'c', 'd']);
  });
});

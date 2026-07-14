import { describe, expect, it } from 'vitest';
import { normalizeContactSheetQuery, searchContactSheetImages } from './contactSheetSearch';
import type { ImageFile } from '../types/image';

const images: ImageFile[] = [
  { path: 'one', file_name: 'Sunset.JPG', extension: 'jpg', size_bytes: 1, modified_at: '1' },
  { path: 'two', file_name: 'forest.png', extension: 'png', size_bytes: 2, modified_at: '2' },
  { path: 'three', file_name: 'notes.txt', extension: 'txt', size_bytes: 3, modified_at: '3' },
];

describe('searchContactSheetImages', () => {
  it('returns every image in original order for an empty query', () => {
    expect(searchContactSheetImages(images, '')).toEqual(
      images.map((image, sourceIndex) => ({ image, sourceIndex }))
    );
  });

  it('trims query edges, matches case-insensitively, and includes extensions', () => {
    expect(searchContactSheetImages(images, '  JPG  ')).toEqual([
      { image: images[0], sourceIndex: 0 },
    ]);
    expect(searchContactSheetImages(images, '.PNG')).toEqual([
      { image: images[1], sourceIndex: 1 },
    ]);
  });

  it('retains the source index of each result', () => {
    expect(searchContactSheetImages(images, 'o')).toEqual([
      { image: images[1], sourceIndex: 1 },
      { image: images[2], sourceIndex: 2 },
    ]);
  });

  it('normalizes query whitespace and casing', () => {
    expect(normalizeContactSheetQuery('  MiXeD  ')).toBe('mixed');
  });
});

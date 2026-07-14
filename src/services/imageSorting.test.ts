import { describe, expect, it, vi } from 'vitest';
import { shuffleImages, sortImages } from './imageSorting';
import type { ImageFile } from '../types/image';

const images: ImageFile[] = [
  { path: 'c:/b.jpg', file_name: 'b.jpg', extension: 'jpg', size_bytes: 200, modified_at: '200' },
  { path: 'c:/a.jpg', file_name: 'a.jpg', extension: 'jpg', size_bytes: 100, modified_at: '100' },
];

describe('sortImages', () => {
  it('sorts by date descending', () => {
    const sorted = sortImages(images, 'date');
    expect(sorted.map((item) => item.file_name)).toEqual(['b.jpg', 'a.jpg']);
  });

  it('puts invalid and missing dates last', () => {
    const dateImages = [
      { ...images[0], file_name: 'old.jpg', path: 'c:/old.jpg', modified_at: '100' },
      { ...images[0], file_name: 'invalid.jpg', path: 'c:/invalid.jpg', modified_at: 'nope' },
      { ...images[0], file_name: 'new.jpg', path: 'c:/new.jpg', modified_at: '200' },
      { ...images[0], file_name: 'missing.jpg', path: 'c:/missing.jpg', modified_at: null },
    ];

    expect(sortImages(dateImages, 'date').map((image) => image.file_name)).toEqual([
      'new.jpg',
      'old.jpg',
      'invalid.jpg',
      'missing.jpg',
    ]);
  });

  it('uses natural name order to resolve equal dates and sizes', () => {
    const tiedImages = [
      { ...images[0], file_name: 'image10.jpg', path: 'c:/image10.jpg', modified_at: '100' },
      { ...images[0], file_name: 'image2.jpg', path: 'c:/image2.jpg', modified_at: '100' },
      { ...images[0], file_name: 'image1.jpg', path: 'c:/image1.jpg', modified_at: '100' },
    ];

    expect(sortImages(tiedImages, 'date').map((image) => image.file_name)).toEqual([
      'image1.jpg',
      'image2.jpg',
      'image10.jpg',
    ]);
    expect(sortImages(tiedImages, 'size').map((image) => image.file_name)).toEqual([
      'image1.jpg',
      'image2.jpg',
      'image10.jpg',
    ]);
  });

  it('sorts by size descending', () => {
    const sorted = sortImages(images, 'size');
    expect(sorted.map((item) => item.file_name)).toEqual(['b.jpg', 'a.jpg']);
  });

  it('sorts by name with natural numeric ordering', () => {
    const nameImages = [
      { ...images[0], file_name: 'image10.jpg', path: 'c:/image10.jpg' },
      { ...images[1], file_name: 'image2.jpg', path: 'c:/image2.jpg' },
      { ...images[1], file_name: 'image1.jpg', path: 'c:/image1.jpg' },
    ];

    const sorted = sortImages(nameImages, 'name');
    expect(sorted.map((item) => item.file_name)).toEqual([
      'image1.jpg',
      'image2.jpg',
      'image10.jpg',
    ]);
  });

  it('uses an injected Fisher-Yates sequence without mutating the input', () => {
    const randomValues = [0.5, 0, 0.9];
    const original = [
      { ...images[0], file_name: 'a.jpg', path: 'c:/a.jpg' },
      { ...images[1], file_name: 'b.jpg', path: 'c:/b.jpg' },
      { ...images[0], file_name: 'c.jpg', path: 'c:/c.jpg' },
      { ...images[1], file_name: 'd.jpg', path: 'c:/d.jpg' },
    ];
    const sorted = shuffleImages(original, () => randomValues.shift() ?? 0);

    expect(sorted.map((image) => image.file_name)).toEqual(['d.jpg', 'b.jpg', 'a.jpg', 'c.jpg']);
    expect(original.map((image) => image.file_name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
  });

  it('does not use Array.sort for random shuffling', () => {
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    shuffleImages(images, () => 0);
    expect(sortSpy).not.toHaveBeenCalled();
    sortSpy.mockRestore();
  });
});

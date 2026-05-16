import { describe, expect, it, vi } from 'vitest';
import { sortImages } from './imageSorting';
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

  it('uses random comparator for random mode', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    sortImages(images, 'random');
    expect(randomSpy).toHaveBeenCalled();
    randomSpy.mockRestore();
  });
});

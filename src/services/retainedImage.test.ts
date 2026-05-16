import { describe, expect, it, vi } from 'vitest';
import { releaseRetainedDecodedImage, type RetainedImageHandle } from './retainedImage';

describe('retainedImage', () => {
  it('releases image handles without assigning an empty URL', () => {
    const srcAssignments: string[] = [];
    const image = {
      onload: vi.fn(),
      onerror: vi.fn(),
      removeAttribute: vi.fn(),
      set src(value: string) {
        srcAssignments.push(value);
      },
    } as unknown as RetainedImageHandle;

    releaseRetainedDecodedImage(image);

    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
    expect(image.removeAttribute).toHaveBeenCalledWith('src');
    expect(srcAssignments).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { BoundedPathMetadataCache } from './pathMetadataCache';

describe('BoundedPathMetadataCache', () => {
  it('normalizes Windows keys and evicts oldest entries at the hard ceiling', () => {
    const cache = new BoundedPathMetadataCache<number>(2);
    cache.set('C:\\Images\\one.jpg', 1);
    cache.set('c:/images/two.jpg', 2);
    cache.set('C:/images/three.jpg', 3);

    expect(cache.get('c:/images/one.jpg')).toBeUndefined();
    expect(cache.get('C:\\Images\\TWO.JPG')).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('releases entries outside the active retention window', () => {
    const cache = new BoundedPathMetadataCache<number>();
    cache.set('one', 1);
    cache.set('two', 2);
    cache.retain(['TWO']);

    expect(cache.get('one')).toBeUndefined();
    expect(cache.get('two')).toBe(2);
    expect(cache.size).toBe(1);
  });
});

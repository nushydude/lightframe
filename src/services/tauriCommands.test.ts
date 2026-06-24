import { describe, expect, it } from 'vitest';
import { getParentFolder } from './tauriCommands';

describe('tauriCommands path helpers', () => {
  it('preserves Windows drive roots when extracting a parent folder', () => {
    expect(getParentFolder('C:\\photo.jpg')).toBe('C:\\');
  });

  it('preserves POSIX roots when extracting a parent folder', () => {
    expect(getParentFolder('/photo.jpg')).toBe('/');
  });

  it('preserves UNC share roots when extracting a parent folder', () => {
    expect(getParentFolder('\\\\server\\share\\photo.jpg')).toBe('\\\\server\\share');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  acquireSlideshowDisplayInhibition,
  getParentFolder,
  releaseSlideshowDisplayInhibition,
} from './tauriCommands';

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

describe('tauriCommands display inhibition wrappers', () => {
  it('invoke the native acquire and release commands', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await acquireSlideshowDisplayInhibition();
    await releaseSlideshowDisplayInhibition();

    expect(vi.mocked(invoke).mock.calls.slice(-2)).toEqual([
      ['acquire_slideshow_display_inhibition'],
      ['release_slideshow_display_inhibition'],
    ]);
  });
});

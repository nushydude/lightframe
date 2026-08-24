import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  acquireSlideshowDisplayInhibition,
  getImageCaption,
  getParentFolder,
  releaseSlideshowDisplayInhibition,
  updateRecentFoldersJumpList,
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

describe('tauriCommands caption wrapper', () => {
  it('requests a same-basename image caption', async () => {
    vi.mocked(invoke).mockResolvedValue({
      text: 'portrait, soft light',
      sidecar_path: 'C:/Images/photo.txt',
      extension: 'txt',
    });

    await expect(getImageCaption('C:/Images/photo.png')).resolves.toMatchObject({
      text: 'portrait, soft light',
    });

    expect(vi.mocked(invoke).mock.calls[vi.mocked(invoke).mock.calls.length - 1]).toEqual([
      'get_image_caption',
      { filePath: 'C:/Images/photo.png' },
    ]);
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

describe('tauriCommands recent folder wrappers', () => {
  it('updates the native Jump List using the persisted folder shape', async () => {
    vi.mocked(invoke).mockResolvedValue(['C:/Removed']);

    await expect(
      updateRecentFoldersJumpList([{ path: 'C:/Images', label: 'Images', openedAt: 123 }])
    ).resolves.toEqual(['C:/Removed']);

    expect(vi.mocked(invoke).mock.calls[vi.mocked(invoke).mock.calls.length - 1]).toEqual([
      'update_recent_folders_jump_list',
      {
        recentFolders: [{ path: 'C:/Images', label: 'Images', opened_at: 123 }],
      },
    ]);
  });
});

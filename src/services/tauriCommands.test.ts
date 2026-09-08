import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  acquireSlideshowDisplayInhibition,
  getImageCaption,
  getParentFolder,
  readCurationMetadata,
  releaseSlideshowDisplayInhibition,
  resetImageReviewDecision,
  updateRecentFoldersJumpList,
  writeImageCuration,
  writeImageCurationBatch,
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

describe('tauriCommands curation wrappers', () => {
  it('maps rust review_status payloads and infers legacy keep from ratings', async () => {
    vi.mocked(invoke).mockResolvedValue({
      'C:/Images/explicit.jpg': {
        path: 'C:/Images/explicit.jpg',
        favorite: false,
        rating: 4,
        review_status: 'unreviewed',
        updated_at: 12,
      },
      'C:/Images/legacy.jpg': {
        path: 'C:/Images/legacy.jpg',
        favorite: false,
        rating: 5,
        updated_at: 13,
      },
    });

    await expect(readCurationMetadata()).resolves.toMatchObject({
      'C:/Images/explicit.jpg': { reviewStatus: 'unreviewed', rating: 4 },
      'C:/Images/legacy.jpg': { reviewStatus: 'keep', rating: 5 },
    });
  });

  it('sends reviewStatus through single and batch write commands', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await writeImageCuration('C:/Images/one.jpg', false, 0, 'reject');
    await writeImageCurationBatch([
      { filePath: 'C:/Images/two.jpg', favorite: true, rating: 5, reviewStatus: 'keep' },
    ]);
    await resetImageReviewDecision('C:/Images/two.jpg');

    expect(vi.mocked(invoke).mock.calls.slice(-3)).toEqual([
      [
        'write_image_curation',
        { filePath: 'C:/Images/one.jpg', favorite: false, rating: 0, reviewStatus: 'reject' },
      ],
      [
        'write_image_curation_batch',
        {
          updates: [
            { filePath: 'C:/Images/two.jpg', favorite: true, rating: 5, reviewStatus: 'keep' },
          ],
        },
      ],
      ['reset_image_review_decision', { filePath: 'C:/Images/two.jpg' }],
    ]);
  });

  it('rejects malformed review statuses before IPC writes', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(invoke).mockClear();

    await expect(
      writeImageCuration('C:/Images/one.jpg', false, 0, 'maybe' as never)
    ).rejects.toThrow('Invalid review status: maybe');
    await expect(
      writeImageCurationBatch([
        {
          filePath: 'C:/Images/two.jpg',
          favorite: false,
          rating: 0,
          reviewStatus: 'maybe' as never,
        },
      ])
    ).rejects.toThrow('Invalid review status: maybe');

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyCurrentImage,
  deleteCurrentImage,
  revealCurrentImage,
  showTransferResultMessage,
  transferImagesToDestination,
} from './viewerActions';

const {
  confirmMock,
  messageMock,
  copyImageToClipboardMock,
  copyImageToFolderMock,
  moveImageToFolderMock,
  moveToTrashMock,
  revealInExplorerMock,
} = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  messageMock: vi.fn(),
  copyImageToClipboardMock: vi.fn(),
  copyImageToFolderMock: vi.fn(),
  moveImageToFolderMock: vi.fn(),
  moveToTrashMock: vi.fn(),
  revealInExplorerMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: confirmMock,
  message: messageMock,
}));

vi.mock('./tauriCommands', () => ({
  copyImageToClipboard: copyImageToClipboardMock,
  copyImageToFolder: copyImageToFolderMock,
  moveImageToFolder: moveImageToFolderMock,
  moveToTrash: moveToTrashMock,
  revealInExplorer: revealInExplorerMock,
}));

describe('viewerActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    messageMock.mockResolvedValue(undefined);
  });

  it('shows an error message when reveal fails', async () => {
    revealInExplorerMock.mockRejectedValue(new Error('reveal failed'));

    await expect(revealCurrentImage('c:/images/test.jpg')).resolves.toBeUndefined();

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining('Failed to reveal file:'),
      expect.objectContaining({ title: 'Error', kind: 'error' })
    );
  });

  it('shows an error message when copy fails', async () => {
    copyImageToClipboardMock.mockRejectedValue(new Error('copy failed'));

    await expect(copyCurrentImage('c:/images/test.jpg')).resolves.toBeUndefined();

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining('Failed to copy image:'),
      expect.objectContaining({ title: 'Error', kind: 'error' })
    );
  });

  it('shows an error message when delete fails', async () => {
    moveToTrashMock.mockRejectedValue(new Error('delete failed'));
    const removeImage = vi.fn();

    await expect(
      deleteCurrentImage({
        currentImagePath: 'c:/images/test.jpg',
        currentIndex: 1,
        removeImage,
      })
    ).resolves.toBeUndefined();

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete:'),
      expect.objectContaining({ title: 'Error', kind: 'error' })
    );
    expect(removeImage).not.toHaveBeenCalled();
  });

  it('transfers images to a quick destination and reports partial failures', async () => {
    copyImageToFolderMock.mockResolvedValueOnce('d:/favorites/test-1.jpg');
    copyImageToFolderMock.mockRejectedValueOnce(new Error('disk full'));

    const result = await transferImagesToDestination(
      ['c:/images/one.jpg', 'c:/images/two.jpg'],
      { id: 'fav', label: 'Favorites', path: 'd:/favorites' },
      'copy'
    );

    expect(result.successes).toEqual([
      { sourcePath: 'c:/images/one.jpg', targetPath: 'd:/favorites/test-1.jpg' },
    ]);
    expect(result.failures).toEqual([
      { sourcePath: 'c:/images/two.jpg', error: 'disk full' },
    ]);
  });

  it('shows a warning message when a quick transfer partially fails', async () => {
    await showTransferResultMessage(
      {
        successes: [{ sourcePath: 'c:/images/one.jpg', targetPath: 'd:/favorites/one.jpg' }],
        failures: [{ sourcePath: 'c:/images/two.jpg', error: 'disk full' }],
      },
      { id: 'fav', label: 'Favorites', path: 'd:/favorites' },
      'move'
    );

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining('Moved 1 image to Favorites, but 1 failed.'),
      expect.objectContaining({ title: 'Move issues', kind: 'warning' })
    );
  });
});

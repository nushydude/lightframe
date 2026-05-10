import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyCurrentImage,
  deleteCurrentImage,
  revealCurrentImage,
} from './viewerActions';

const {
  confirmMock,
  messageMock,
  copyImageToClipboardMock,
  moveToTrashMock,
  revealInExplorerMock,
} = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  messageMock: vi.fn(),
  copyImageToClipboardMock: vi.fn(),
  moveToTrashMock: vi.fn(),
  revealInExplorerMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: confirmMock,
  message: messageMock,
}));

vi.mock('./tauriCommands', () => ({
  copyImageToClipboard: copyImageToClipboardMock,
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
});

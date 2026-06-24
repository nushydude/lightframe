import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyCurrentImagePath,
  copyCurrentImage,
  deleteImages,
  deleteCurrentImage,
  openCurrentImageInEditor,
  revealCurrentImage,
  showTransferResultMessage,
  transferImagesToDestination,
} from './viewerActions';
import { useSettingsStore } from '../state/settingsStore';
import { useToastStore } from '../state/toastStore';

const {
  confirmMock,
  copyImageToClipboardMock,
  moveToTrashMock,
  openInExternalApplicationMock,
  revealInExplorerMock,
  transferImagesToFolderMock,
} = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  copyImageToClipboardMock: vi.fn(),
  moveToTrashMock: vi.fn(),
  openInExternalApplicationMock: vi.fn(),
  revealInExplorerMock: vi.fn(),
  transferImagesToFolderMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: confirmMock,
}));

vi.mock('./tauriCommands', () => ({
  copyImageToClipboard: copyImageToClipboardMock,
  moveToTrash: moveToTrashMock,
  openInExternalApplication: openInExternalApplicationMock,
  revealInExplorer: revealInExplorerMock,
  transferImagesToFolder: transferImagesToFolderMock,
}));

describe('viewerActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    moveToTrashMock.mockResolvedValue(undefined);
    useToastStore.getState().clearToasts();
    useSettingsStore.getState().updateSettings = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        externalEditorPath: undefined,
        externalEditorLabel: undefined,
      },
    }));
  });

  it('shows an error message when reveal fails', async () => {
    revealInExplorerMock.mockRejectedValue(new Error('reveal failed'));

    await expect(revealCurrentImage('c:/images/test.jpg')).resolves.toBeUndefined();

    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Reveal failed',
        kind: 'error',
        message: expect.stringContaining('Failed to reveal file:'),
      })
    );
  });

  it('shows an error message when copy fails', async () => {
    copyImageToClipboardMock.mockRejectedValue(new Error('copy failed'));

    await expect(copyCurrentImage('c:/images/test.jpg')).resolves.toBeUndefined();

    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Clipboard copy failed',
        kind: 'error',
        message: expect.stringContaining('Failed to copy image:'),
      })
    );
  });

  it('shows a helpful message when no external editor is configured', async () => {
    await expect(openCurrentImageInEditor('c:/images/test.jpg')).resolves.toBeUndefined();

    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'External editor not configured',
        kind: 'warning',
        message: 'No external editor is configured.',
        detail: 'Set one in Settings > External Editor.',
      })
    );
    expect(openInExternalApplicationMock).not.toHaveBeenCalled();
  });

  it('shows an error message when opening the external editor fails', async () => {
    openInExternalApplicationMock.mockRejectedValue(new Error('launch failed'));
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        externalEditorPath: 'c:/Program Files/Paint.NET/paintdotnet.exe',
        externalEditorLabel: 'Paint.NET',
      },
    }));

    await expect(openCurrentImageInEditor('c:/images/test.jpg')).resolves.toBeUndefined();

    expect(openInExternalApplicationMock).toHaveBeenCalledWith(
      'c:/images/test.jpg',
      'c:/Program Files/Paint.NET/paintdotnet.exe'
    );
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Could not open editor',
        kind: 'error',
        message: expect.stringContaining('Failed to open image in Paint.NET:'),
      })
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

    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Delete failed',
        kind: 'error',
        message: expect.stringContaining('Failed to delete:'),
      })
    );
    expect(removeImage).not.toHaveBeenCalled();
  });

  it('deletes multiple images and removes successful paths in one pass', async () => {
    const removeImagesByPaths = vi.fn();

    await expect(
      deleteImages({
        imagePaths: ['c:/images/one.jpg', 'c:/images/two.jpg'],
        removeImagesByPaths,
      })
    ).resolves.toBeUndefined();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/one.jpg');
    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/two.jpg');
    expect(removeImagesByPaths).toHaveBeenCalledWith(['c:/images/one.jpg', 'c:/images/two.jpg']);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Images deleted',
        kind: 'success',
      })
    );
  });

  it('transfers images to a quick destination and reports partial failures', async () => {
    transferImagesToFolderMock.mockResolvedValue({
      successes: [{ sourcePath: 'c:/images/one.jpg', targetPath: 'd:/favorites/test-1.jpg' }],
      failures: [{ sourcePath: 'c:/images/two.jpg', error: 'disk full' }],
    });

    const result = await transferImagesToDestination(
      ['c:/images/one.jpg', 'c:/images/two.jpg'],
      { id: 'fav', label: 'Favorites', path: 'd:/favorites' },
      'copy'
    );

    expect(transferImagesToFolderMock).toHaveBeenCalledWith(
      ['c:/images/one.jpg', 'c:/images/two.jpg'],
      'd:/favorites',
      'copy'
    );
    expect(result.successes).toEqual([
      { sourcePath: 'c:/images/one.jpg', targetPath: 'd:/favorites/test-1.jpg' },
    ]);
    expect(result.failures).toEqual([{ sourcePath: 'c:/images/two.jpg', error: 'disk full' }]);
    expect(result.failureCount).toBe(1);
  });

  it('shows a warning message when a quick transfer partially fails', async () => {
    showTransferResultMessage(
      {
        successes: [{ sourcePath: 'c:/images/one.jpg', targetPath: 'd:/favorites/one.jpg' }],
        failures: [{ sourcePath: 'c:/images/two.jpg', error: 'disk full' }],
        failureCount: 1,
      },
      { id: 'fav', label: 'Favorites', path: 'd:/favorites' },
      'move'
    );

    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Move issues',
        kind: 'warning',
        message: 'Moved 1 image to Favorites, but 1 failed.',
        detail: 'c:/images/two.jpg\ndisk full',
      })
    );
  });

  it('expands thrown bulk transfer failures across the full selection', async () => {
    transferImagesToFolderMock.mockRejectedValue(new Error('share offline'));

    const result = await transferImagesToDestination(
      ['c:/images/one.jpg', 'c:/images/two.jpg', 'c:/images/three.jpg'],
      { id: 'fav', label: 'Favorites', path: 'd:/favorites' },
      'copy'
    );

    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([
      { sourcePath: 'c:/images/one.jpg', error: 'share offline' },
      { sourcePath: 'c:/images/two.jpg', error: 'share offline' },
      { sourcePath: 'c:/images/three.jpg', error: 'share offline' },
    ]);
    expect(result.failureCount).toBe(3);
  });

  it('falls back to the legacy clipboard path when navigator.clipboard rejects', async () => {
    const clipboardWriteText = vi.fn().mockRejectedValue(new Error('denied'));
    const execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommandMock,
    });
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
      },
    });

    await expect(copyCurrentImagePath('c:/images/test.jpg')).resolves.toBeUndefined();

    expect(clipboardWriteText).toHaveBeenCalledWith('c:/images/test.jpg');
    expect(execCommandMock).toHaveBeenCalledWith('copy');
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Image path copied',
        kind: 'success',
        message: 'c:/images/test.jpg',
      })
    );
  });
});

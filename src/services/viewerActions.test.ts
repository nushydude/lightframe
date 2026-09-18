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
import { useViewerStore } from '../state/viewerStore';
import type { ImageFile } from '../types/image';

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

function createImage(path: string): ImageFile {
  const fileName = path.split('/').pop() ?? path;
  return {
    path,
    file_name: fileName,
    extension: fileName.split('.').pop() ?? '',
    size_bytes: 100,
    modified_at: '1000',
  };
}

function setViewerImages(paths: string[], currentIndex: number): void {
  const images = paths.map(createImage);
  useViewerStore.getState().setImages(images);
  useViewerStore.getState().setCurrentIndex(currentIndex);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
    useViewerStore.getState().reset();
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
    const removeImagesByPaths = vi.fn();

    await expect(
      deleteCurrentImage({
        currentImagePath: 'c:/images/test.jpg',
        removeImagesByPaths,
      })
    ).resolves.toBeUndefined();

    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Delete failed',
        kind: 'error',
        message: expect.stringContaining('Failed to delete:'),
      })
    );
    expect(removeImagesByPaths).not.toHaveBeenCalled();
  });

  it('deletes an ordinary middle image and selects the next image', async () => {
    setViewerImages(
      ['c:/images/a.jpg', 'c:/images/b.jpg', 'c:/images/c.jpg', 'c:/images/d.jpg'],
      1
    );

    await deleteCurrentImage({
      currentImagePath: 'c:/images/b.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });

    expect(moveToTrashMock).toHaveBeenCalledTimes(1);
    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/b.jpg');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      'c:/images/a.jpg',
      'c:/images/c.jpg',
      'c:/images/d.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/images/c.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(1);
  });

  it('keeps the watcher-first deletion idempotent and preserves the next image', async () => {
    setViewerImages(
      ['c:/images/a.jpg', 'c:/images/b.jpg', 'c:/images/c.jpg', 'c:/images/d.jpg'],
      1
    );
    const trash = createDeferred<void>();
    moveToTrashMock.mockReturnValue(trash.promise);

    const deletePromise = deleteCurrentImage({
      currentImagePath: 'c:/images/b.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });
    await vi.waitFor(() => expect(moveToTrashMock).toHaveBeenCalledTimes(1));

    useViewerStore
      .getState()
      .setImages([
        createImage('c:/images/a.jpg'),
        createImage('c:/images/c.jpg'),
        createImage('c:/images/d.jpg'),
      ]);
    trash.resolve(undefined);
    await deletePromise;

    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/b.jpg');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      'c:/images/a.jpg',
      'c:/images/c.jpg',
      'c:/images/d.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/images/c.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(1);
  });

  it('keeps the command-first deletion stable when the watcher follows', async () => {
    setViewerImages(
      ['c:/images/a.jpg', 'c:/images/b.jpg', 'c:/images/c.jpg', 'c:/images/d.jpg'],
      1
    );

    await deleteCurrentImage({
      currentImagePath: 'c:/images/b.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });
    useViewerStore
      .getState()
      .setImages([
        createImage('c:/images/a.jpg'),
        createImage('c:/images/c.jpg'),
        createImage('c:/images/d.jpg'),
      ]);

    expect(moveToTrashMock).toHaveBeenCalledTimes(1);
    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/b.jpg');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      'c:/images/a.jpg',
      'c:/images/c.jpg',
      'c:/images/d.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/images/c.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(1);
  });

  it('selects the next image when deleting the first image', async () => {
    setViewerImages(['c:/images/a.jpg', 'c:/images/b.jpg', 'c:/images/c.jpg'], 0);

    await deleteCurrentImage({
      currentImagePath: 'c:/images/a.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });

    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/a.jpg');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      'c:/images/b.jpg',
      'c:/images/c.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/images/b.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(0);
  });

  it('selects the previous image when deleting the last image', async () => {
    setViewerImages(['c:/images/a.jpg', 'c:/images/b.jpg', 'c:/images/c.jpg'], 2);

    await deleteCurrentImage({
      currentImagePath: 'c:/images/c.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });

    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/c.jpg');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      'c:/images/a.jpg',
      'c:/images/b.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/images/b.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(1);
  });

  it('clears the viewer when deleting the only image', async () => {
    setViewerImages(['c:/images/a.jpg'], 0);

    await deleteCurrentImage({
      currentImagePath: 'c:/images/a.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });

    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/a.jpg');
    expect(useViewerStore.getState().images).toEqual([]);
    expect(useViewerStore.getState().currentImagePath).toBeNull();
    expect(useViewerStore.getState().currentIndex).toBe(-1);
  });

  it('removes the captured image while preserving navigation during a pending delete', async () => {
    setViewerImages(
      ['c:/images/a.jpg', 'c:/images/b.jpg', 'c:/images/c.jpg', 'c:/images/d.jpg'],
      1
    );
    const trash = createDeferred<void>();
    moveToTrashMock.mockReturnValue(trash.promise);

    const deletePromise = deleteCurrentImage({
      currentImagePath: 'c:/images/b.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });
    await vi.waitFor(() => expect(moveToTrashMock).toHaveBeenCalledTimes(1));
    useViewerStore.getState().setCurrentIndex(3);
    trash.resolve(undefined);
    await deletePromise;

    expect(moveToTrashMock).toHaveBeenCalledTimes(1);
    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/b.jpg');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      'c:/images/a.jpg',
      'c:/images/c.jpg',
      'c:/images/d.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/images/d.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(2);
  });

  it('removes the captured image after a reorder during a pending delete', async () => {
    setViewerImages(
      ['c:/images/a.jpg', 'c:/images/b.jpg', 'c:/images/c.jpg', 'c:/images/d.jpg'],
      1
    );
    const trash = createDeferred<void>();
    moveToTrashMock.mockReturnValue(trash.promise);

    const deletePromise = deleteCurrentImage({
      currentImagePath: 'c:/images/b.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });
    await vi.waitFor(() => expect(moveToTrashMock).toHaveBeenCalledTimes(1));
    useViewerStore
      .getState()
      .setImages([
        createImage('c:/images/d.jpg'),
        createImage('c:/images/c.jpg'),
        createImage('c:/images/a.jpg'),
        createImage('c:/images/b.jpg'),
      ]);
    useViewerStore.getState().setCurrentIndex(0);
    trash.resolve(undefined);
    await deletePromise;

    expect(moveToTrashMock).toHaveBeenCalledTimes(1);
    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/b.jpg');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      'c:/images/d.jpg',
      'c:/images/c.jpg',
      'c:/images/a.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/images/d.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(0);
  });

  it('removes a deleted image from the visible favorites list without losing survivors', async () => {
    const allPaths = [
      'c:/images/a.jpg',
      'c:/images/b.jpg',
      'c:/images/c.jpg',
      'c:/images/d.jpg',
      'c:/images/e.jpg',
    ];
    useViewerStore.getState().setImages(allPaths.map(createImage));
    useViewerStore.getState().syncFavoriteFilter({
      'c:/images/b.jpg': { favorite: true },
      'c:/images/c.jpg': { favorite: true },
      'c:/images/e.jpg': { favorite: true },
    });
    useViewerStore.getState().setCurationFilter('favorites');
    useViewerStore.getState().setCurrentIndex(1);
    const trash = createDeferred<void>();
    moveToTrashMock.mockReturnValue(trash.promise);

    const deletePromise = deleteCurrentImage({
      currentImagePath: 'c:/images/c.jpg',
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });
    await vi.waitFor(() => expect(moveToTrashMock).toHaveBeenCalledTimes(1));
    useViewerStore
      .getState()
      .setImages(allPaths.filter((path) => path !== 'c:/images/c.jpg').map(createImage));
    trash.resolve(undefined);
    await deletePromise;

    expect(moveToTrashMock).toHaveBeenCalledTimes(1);
    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/c.jpg');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      'c:/images/b.jpg',
      'c:/images/e.jpg',
    ]);
    expect(useViewerStore.getState().allImages.map((image) => image.path)).toEqual([
      'c:/images/a.jpg',
      'c:/images/b.jpg',
      'c:/images/d.jpg',
      'c:/images/e.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/images/e.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(1);
  });

  it('does not remove an image when deletion is cancelled', async () => {
    confirmMock.mockResolvedValue(false);
    setViewerImages(['c:/images/a.jpg', 'c:/images/b.jpg'], 1);
    const removeImagesByPaths = vi.fn();

    await deleteCurrentImage({
      currentImagePath: 'c:/images/b.jpg',
      removeImagesByPaths,
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(moveToTrashMock).not.toHaveBeenCalled();
    expect(removeImagesByPaths).not.toHaveBeenCalled();
  });

  it('does not remove an image when deletion fails', async () => {
    moveToTrashMock.mockRejectedValue(new Error('delete failed'));
    const removeImagesByPaths = vi.fn();

    await deleteCurrentImage({
      currentImagePath: 'c:/images/b.jpg',
      removeImagesByPaths,
    });

    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/b.jpg');
    expect(removeImagesByPaths).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({ title: 'Delete failed', kind: 'error' })
    );
  });

  it('removes the captured path after a warning-bearing successful trash result', async () => {
    const removeImagesByPaths = vi.fn();
    moveToTrashMock.mockResolvedValue({ warning: 'recovery metadata unavailable' });

    await deleteCurrentImage({
      currentImagePath: 'c:/images/b.jpg',
      removeImagesByPaths,
    });

    expect(moveToTrashMock).toHaveBeenCalledTimes(1);
    expect(moveToTrashMock).toHaveBeenCalledWith('c:/images/b.jpg');
    expect(removeImagesByPaths).toHaveBeenCalledTimes(1);
    expect(removeImagesByPaths).toHaveBeenCalledWith(['c:/images/b.jpg']);
  });

  it('does nothing when there is no current image', async () => {
    const removeImagesByPaths = vi.fn();

    await deleteCurrentImage({
      currentImagePath: null,
      removeImagesByPaths,
    });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(moveToTrashMock).not.toHaveBeenCalled();
    expect(removeImagesByPaths).not.toHaveBeenCalled();
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

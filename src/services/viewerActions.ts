import { confirm, message } from '@tauri-apps/plugin-dialog';
import { copyImageToClipboard, moveToTrash, revealInExplorer } from './tauriCommands';

interface DeleteCurrentImageOptions {
  currentImagePath: string | null;
  currentIndex: number;
  removeImage: (index: number) => void;
}

export function canSaveRotationForPath(filePath: string | null): boolean {
  if (!filePath) {
    return false;
  }

  const extension = filePath.replace(/\\/g, '/').split('.').pop()?.toLowerCase() ?? '';
  return ['bmp', 'jpg', 'jpeg', 'png', 'webp'].includes(extension);
}

export async function revealCurrentImage(currentImagePath: string | null): Promise<void> {
  if (!currentImagePath) {
    return;
  }

  try {
    await revealInExplorer(currentImagePath);
  } catch (err) {
    console.error('Failed to reveal file:', err);
    await message(`Failed to reveal file: ${err}`, { title: 'Error', kind: 'error' });
  }
}

export async function copyCurrentImage(currentImagePath: string | null): Promise<void> {
  if (!currentImagePath) {
    return;
  }

  try {
    await copyImageToClipboard(currentImagePath);
    await message('Image copied to clipboard!', { title: 'Success', kind: 'info' });
  } catch (err) {
    console.error('Failed to copy image:', err);
    await message(`Failed to copy image: ${err}`, { title: 'Error', kind: 'error' });
  }
}

export async function deleteCurrentImage({
  currentImagePath,
  currentIndex,
  removeImage,
}: DeleteCurrentImageOptions): Promise<void> {
  if (!currentImagePath) {
    return;
  }

  try {
    const fileName = currentImagePath.replace(/\\/g, '/').split('/').pop() ?? currentImagePath;
    const confirmed = await confirm(
      `Are you sure you want to move this image to the Recycle Bin?\n\n${fileName}`,
      {
        title: 'Delete Image',
        kind: 'warning',
      }
    );

    if (!confirmed) {
      return;
    }

    await moveToTrash(currentImagePath);
    removeImage(currentIndex);
  } catch (err) {
    console.error('Failed to move to trash:', err);
    await message(`Failed to delete: ${err}`, { title: 'Error', kind: 'error' });
  }
}

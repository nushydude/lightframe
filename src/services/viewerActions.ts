import { confirm, message } from '@tauri-apps/plugin-dialog';
import {
  copyImageToClipboard,
  copyImageToFolder,
  moveImageToFolder,
  moveToTrash,
  revealInExplorer,
} from './tauriCommands';
import type { QuickDestination } from '../types/settings';

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

export interface QuickTransferSuccess {
  sourcePath: string;
  targetPath: string;
}

export interface QuickTransferFailure {
  sourcePath: string;
  error: string;
}

export interface QuickTransferResult {
  successes: QuickTransferSuccess[];
  failures: QuickTransferFailure[];
}

export async function transferImagesToDestination(
  imagePaths: string[],
  destination: QuickDestination,
  mode: 'copy' | 'move'
): Promise<QuickTransferResult> {
  const successes: QuickTransferSuccess[] = [];
  const failures: QuickTransferFailure[] = [];

  for (const imagePath of imagePaths) {
    try {
      const targetPath =
        mode === 'copy'
          ? await copyImageToFolder(imagePath, destination.path)
          : await moveImageToFolder(imagePath, destination.path);
      successes.push({ sourcePath: imagePath, targetPath });
    } catch (err) {
      failures.push({
        sourcePath: imagePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { successes, failures };
}

export async function showTransferResultMessage(
  result: QuickTransferResult,
  destination: QuickDestination,
  mode: 'copy' | 'move'
): Promise<void> {
  const verb = mode === 'copy' ? 'Copied' : 'Moved';
  const noun = result.successes.length === 1 ? 'image' : 'images';

  if (result.failures.length === 0) {
    await message(`${verb} ${result.successes.length} ${noun} to ${destination.label}.`, {
      title: mode === 'copy' ? 'Copy complete' : 'Move complete',
      kind: 'info',
    });
    return;
  }

  const firstFailure = result.failures[0];
  const partialPrefix =
    result.successes.length > 0
      ? `${verb} ${result.successes.length} ${noun} to ${destination.label}, but ${result.failures.length} failed.`
      : `Could not ${mode} the selected images to ${destination.label}.`;
  await message(
    `${partialPrefix}\n\nFirst failure:\n${firstFailure.sourcePath}\n${firstFailure.error}`,
    {
      title: mode === 'copy' ? 'Copy issues' : 'Move issues',
      kind: result.successes.length > 0 ? 'warning' : 'error',
    }
  );
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

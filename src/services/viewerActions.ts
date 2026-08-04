import { getRuntime } from './runtime/runtime';
import {
  copyImageToClipboard,
  getFileName,
  moveToTrash,
  openInExternalApplication,
  revealInExplorer,
  transferImagesToFolder,
} from './tauriCommands';
import { useSettingsStore } from '../state/settingsStore';
import { useToastStore } from '../state/toastStore';
import type { QuickDestination } from '../types/settings';

interface DeleteCurrentImageOptions {
  currentImagePath: string | null;
  currentIndex: number;
  removeImage: (index: number) => void;
}

interface DeleteImagesOptions {
  imagePaths: string[];
  removeImagesByPaths: (paths: string[]) => void;
}

interface DeleteFailure {
  path: string;
  error: string;
}

interface DeleteResult {
  successes: string[];
  failures: DeleteFailure[];
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
  failureCount: number;
}

export async function transferImagesToDestination(
  imagePaths: string[],
  destination: QuickDestination,
  mode: 'copy' | 'move'
): Promise<QuickTransferResult> {
  try {
    const result = await transferImagesToFolder(imagePaths, destination.path, mode);
    return {
      ...result,
      failureCount: result.failures.length,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failures = imagePaths.length
      ? imagePaths.map((sourcePath) => ({ sourcePath, error }))
      : [{ sourcePath: destination.path, error }];
    return {
      successes: [],
      failures,
      failureCount: failures.length,
    };
  }
}

export function showTransferResultMessage(
  result: QuickTransferResult,
  destination: QuickDestination,
  mode: 'copy' | 'move'
): void {
  const verb = mode === 'copy' ? 'Copied' : 'Moved';
  const noun = result.successes.length === 1 ? 'image' : 'images';
  const pushToast = useToastStore.getState().pushToast;

  if (result.failureCount === 0) {
    pushToast({
      title: mode === 'copy' ? 'Copy complete' : 'Move complete',
      kind: 'success',
      message: `${verb} ${result.successes.length} ${noun} to ${destination.label}.`,
    });
    return;
  }

  const firstFailure = result.failures[0];
  const partialPrefix =
    result.successes.length > 0
      ? `${verb} ${result.successes.length} ${noun} to ${destination.label}, but ${result.failureCount} failed.`
      : `Could not ${mode} the selected images to ${destination.label}.`;
  pushToast({
    title: mode === 'copy' ? 'Copy issues' : 'Move issues',
    kind: result.successes.length > 0 ? 'warning' : 'error',
    message: partialPrefix,
    detail: `${firstFailure.sourcePath}\n${firstFailure.error}`,
    duration: result.successes.length > 0 ? 7000 : 8000,
  });
}

export async function revealCurrentImage(currentImagePath: string | null): Promise<void> {
  if (!currentImagePath) {
    return;
  }

  try {
    await revealInExplorer(currentImagePath);
  } catch (err) {
    console.error('Failed to reveal file:', err);
    useToastStore.getState().pushToast({
      title: 'Reveal failed',
      kind: 'error',
      message: `Failed to reveal file: ${err}`,
    });
  }
}

export async function copyCurrentImage(currentImagePath: string | null): Promise<void> {
  if (!currentImagePath) {
    return;
  }

  try {
    await copyImageToClipboard(currentImagePath);
    useToastStore.getState().pushToast({
      title: 'Copied to clipboard',
      kind: 'success',
      message: 'Image copied to clipboard.',
    });
  } catch (err) {
    console.error('Failed to copy image:', err);
    useToastStore.getState().pushToast({
      title: 'Clipboard copy failed',
      kind: 'error',
      message: `Failed to copy image: ${err}`,
    });
  }
}

function fallbackCopyText(text: string): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  textArea.style.pointerEvents = 'none';
  document.body.appendChild(textArea);
  textArea.select();

  let didCopy = false;
  try {
    didCopy = document.execCommand('copy');
  } catch (err) {
    console.error('Failed to copy text with fallback clipboard path:', err);
  } finally {
    document.body.removeChild(textArea);
  }

  return didCopy;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      if (fallbackCopyText(text)) {
        return;
      }
      throw new Error('Clipboard text copy is unavailable.');
    }
  }

  if (!fallbackCopyText(text)) {
    throw new Error('Clipboard text copy is unavailable.');
  }
}

export async function copyCurrentImagePath(currentImagePath: string | null): Promise<void> {
  if (!currentImagePath) {
    return;
  }

  try {
    await copyTextToClipboard(currentImagePath);

    useToastStore.getState().pushToast({
      title: 'Image path copied',
      kind: 'success',
      message: currentImagePath,
    });
  } catch (err) {
    console.error('Failed to copy image path:', err);
    useToastStore.getState().pushToast({
      title: 'Path copy failed',
      kind: 'error',
      message: `Failed to copy image path: ${err}`,
    });
  }
}

export async function copyCurrentImageFileName(currentImagePath: string | null): Promise<void> {
  if (!currentImagePath) {
    return;
  }

  const fileName = getFileName(currentImagePath);
  if (!fileName) {
    return;
  }

  try {
    await copyTextToClipboard(fileName);

    useToastStore.getState().pushToast({
      title: 'Filename copied',
      kind: 'success',
      message: fileName,
    });
  } catch (err) {
    console.error('Failed to copy filename:', err);
    useToastStore.getState().pushToast({
      title: 'Filename copy failed',
      kind: 'error',
      message: `Failed to copy filename: ${err}`,
    });
  }
}

export async function chooseQuickDestinationFolder(): Promise<QuickDestination | null> {
  const selected = await getRuntime().openFolder();
  if (!selected || typeof selected !== 'string') {
    return null;
  }

  const normalizedPath = selected.trim();
  if (!normalizedPath) {
    return null;
  }

  const label =
    normalizedPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || normalizedPath;
  return {
    id: `adhoc-${Date.now()}`,
    label,
    path: normalizedPath,
  };
}

export async function openCurrentImageInEditor(
  currentImagePath: string | null,
  externalEditorPath?: string | null,
  externalEditorLabel?: string | null
): Promise<void> {
  if (!currentImagePath) {
    return;
  }

  const settings = useSettingsStore.getState().settings;
  const editorPath = externalEditorPath?.trim() || settings.externalEditorPath?.trim();

  if (!editorPath) {
    useToastStore.getState().pushToast({
      title: 'External editor not configured',
      kind: 'warning',
      message: 'No external editor is configured.',
      detail: 'Set one in Settings > External Editor.',
    });
    return;
  }

  const editorExecutable = editorPath.replace(/\\/g, '/').split('/').pop() ?? editorPath;
  const editorLabel =
    externalEditorLabel?.trim() ||
    settings.externalEditorLabel?.trim() ||
    editorExecutable.replace(/\.[^.]+$/, '');

  try {
    await openInExternalApplication(currentImagePath, editorPath);
  } catch (err) {
    console.error('Failed to open image in external editor:', err);
    useToastStore.getState().pushToast({
      title: 'Could not open editor',
      kind: 'error',
      message: `Failed to open image in ${editorLabel}: ${err}`,
    });
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
    const confirmed = await getRuntime().confirm(
      `Are you sure you want to move this image to the Recycle Bin?\n\n${fileName}`,
      { title: 'Delete Image', kind: 'warning' }
    );

    if (!confirmed) {
      return;
    }

    await moveToTrash(currentImagePath);
    removeImage(currentIndex);
  } catch (err) {
    console.error('Failed to move to trash:', err);
    useToastStore.getState().pushToast({
      title: 'Delete failed',
      kind: 'error',
      message: `Failed to delete: ${err}`,
    });
  }
}

function normalizeDeletePaths(imagePaths: string[]): string[] {
  return Array.from(new Set(imagePaths.map((path) => path.trim()).filter(Boolean)));
}

function getDeleteConfirmationOptions(imagePaths: string[]): {
  message: string;
  title: 'Delete Image' | 'Delete Images';
} {
  const firstFileName =
    imagePaths[0]?.replace(/\\/g, '/').split('/').pop() ?? imagePaths[0] ?? 'image';

  if (imagePaths.length === 1) {
    return {
      message: `Are you sure you want to move this image to the Recycle Bin?\n\n${firstFileName}`,
      title: 'Delete Image',
    };
  }

  return {
    message: `Are you sure you want to move ${imagePaths.length} images to the Recycle Bin?\n\nFirst item: ${firstFileName}`,
    title: 'Delete Images',
  };
}

async function confirmDeleteImages(imagePaths: string[]): Promise<boolean> {
  const { message, title } = getDeleteConfirmationOptions(imagePaths);
  return getRuntime().confirm(message, { title, kind: 'warning' });
}

async function moveImagesToTrash(imagePaths: string[]): Promise<DeleteResult> {
  const successes: string[] = [];
  const failures: DeleteFailure[] = [];

  for (const path of imagePaths) {
    try {
      await moveToTrash(path);
      successes.push(path);
    } catch (err) {
      console.error('Failed to move to trash:', err);
      failures.push({
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { successes, failures };
}

function showDeleteResultToast(successes: string[], failures: DeleteFailure[]): void {
  const pushToast = useToastStore.getState().pushToast;

  if (failures.length === 0) {
    pushToast({
      title: successes.length === 1 ? 'Image deleted' : 'Images deleted',
      kind: 'success',
      message:
        successes.length === 1
          ? 'Moved image to the Recycle Bin.'
          : `Moved ${successes.length} images to the Recycle Bin.`,
    });
    return;
  }

  pushToast({
    title: successes.length > 0 ? 'Delete issues' : 'Delete failed',
    kind: successes.length > 0 ? 'warning' : 'error',
    message:
      successes.length > 0
        ? `Deleted ${successes.length} images, but ${failures.length} failed.`
        : 'Could not delete the selected images.',
    detail: `${failures[0]?.path ?? ''}\n${failures[0]?.error ?? ''}`.trim(),
    duration: 8000,
  });
}

export async function deleteImages({
  imagePaths,
  removeImagesByPaths,
}: DeleteImagesOptions): Promise<void> {
  const normalizedPaths = normalizeDeletePaths(imagePaths);
  if (normalizedPaths.length === 0) {
    return;
  }

  const confirmed = await confirmDeleteImages(normalizedPaths);
  if (!confirmed) {
    return;
  }

  const { successes, failures } = await moveImagesToTrash(normalizedPaths);

  if (successes.length > 0) {
    removeImagesByPaths(successes);
  }

  showDeleteResultToast(successes, failures);
}

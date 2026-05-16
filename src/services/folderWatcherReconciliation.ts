import type { ImageFile } from '../types/image';
import type { AppSettings } from '../types/settings';
import { sortImages } from './imageSorting';
import type { FolderWatcherPayload } from './tauriCommands';

export const MAX_INCREMENTAL_FOLDER_WATCHER_CHANGES = 64;

export interface FolderWatcherReconciliationOptions {
  payload: FolderWatcherPayload;
  images: ImageFile[];
  currentIndex: number;
  currentImagePath: string | null;
  sortOrder: AppSettings['sortOrder'];
}

export interface FolderWatcherReconciliationResult {
  images: ImageFile[];
  invalidatedPaths: string[];
  preferredIndex: number;
  preferredPath: string | null;
  requiresFullRefresh: boolean;
}

export function reconcileFolderWatcherPayload(
  options: FolderWatcherReconciliationOptions
): FolderWatcherReconciliationResult {
  const { payload, images, currentIndex, currentImagePath, sortOrder } = options;
  if (
    payload.requiresFullRefresh ||
    payload.changes.length > MAX_INCREMENTAL_FOLDER_WATCHER_CHANGES
  ) {
    return {
      images,
      invalidatedPaths: [],
      preferredIndex: currentIndex,
      preferredPath: currentImagePath,
      requiresFullRefresh: true,
    };
  }

  const imagesByPath = new Map(images.map((image) => [pathKey(image.path), image]));
  const invalidatedPaths = new Set<string>();
  let preferredPath = currentImagePath;

  for (const change of payload.changes) {
    switch (change.kind) {
      case 'added':
        if (change.image) {
          invalidatedPaths.add(change.image.path);
          imagesByPath.set(pathKey(change.image.path), change.image);
          if (currentImagePath && isSamePath(change.image.path, currentImagePath)) {
            preferredPath = change.image.path;
          }
        }
        break;
      case 'removed':
        imagesByPath.delete(pathKey(change.path));
        invalidatedPaths.add(change.path);
        if (currentImagePath && isSamePath(change.path, currentImagePath)) {
          preferredPath = null;
        }
        break;
      case 'modified':
        invalidatedPaths.add(change.path);
        if (change.image) {
          imagesByPath.set(pathKey(change.image.path), change.image);
        }
        break;
      case 'renamed':
        applyRenamedChange(imagesByPath, invalidatedPaths, change);
        if (currentImagePath && change.oldPath && isSamePath(change.oldPath, currentImagePath)) {
          preferredPath = change.image?.path ?? change.path;
        }
        break;
    }
  }

  const nextImages = sortImages(Array.from(imagesByPath.values()), sortOrder);
  const preferredIndex = resolvePreferredIndex(nextImages, currentIndex, preferredPath);
  const resolvedPreferredPath =
    preferredPath && nextImages.some((image) => isSamePath(image.path, preferredPath))
      ? preferredPath
      : null;

  return {
    images: nextImages,
    invalidatedPaths: Array.from(invalidatedPaths),
    preferredIndex,
    preferredPath: resolvedPreferredPath,
    requiresFullRefresh: false,
  };
}

function applyRenamedChange(
  imagesByPath: Map<string, ImageFile>,
  invalidatedPaths: Set<string>,
  change: FolderWatcherPayload['changes'][number]
) {
  if (change.oldPath) {
    imagesByPath.delete(pathKey(change.oldPath));
    invalidatedPaths.add(change.oldPath);
  }

  invalidatedPaths.add(change.path);
  if (change.image) {
    imagesByPath.set(pathKey(change.image.path), change.image);
  }
}

function resolvePreferredIndex(
  images: ImageFile[],
  previousIndex: number,
  preferredPath: string | null
): number {
  if (images.length === 0) {
    return -1;
  }

  if (preferredPath) {
    const matchedIndex = images.findIndex((image) => isSamePath(image.path, preferredPath));
    if (matchedIndex >= 0) {
      return matchedIndex;
    }
  }

  return Math.min(Math.max(previousIndex, 0), images.length - 1);
}

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function isSamePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

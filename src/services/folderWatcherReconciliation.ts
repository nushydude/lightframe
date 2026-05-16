import type { ImageFile } from '../types/image';
import type { AppSettings } from '../types/settings';
import { sortImages } from './imageSorting';
import type { FolderWatcherPayload } from './tauriCommands';

const MAX_INCREMENTAL_FOLDER_WATCHER_CHANGES = 64;
type FolderWatcherChange = FolderWatcherPayload['changes'][number];
type ImagesByPath = Map<string, ImageFile>;

interface FolderWatcherReconciliationDraft {
  imagesByPath: ImagesByPath;
  invalidatedPaths: Set<string>;
  preferredPath: string | null;
  currentImagePath: string | null;
}

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
  if (requiresFullRefresh(payload)) {
    return fullRefreshResult(images, currentIndex, currentImagePath);
  }

  const draft = applyFolderWatcherChanges(images, payload.changes, currentImagePath);
  return reconcileDraft(draft, currentIndex, sortOrder);
}

function requiresFullRefresh(payload: FolderWatcherPayload): boolean {
  return (
    payload.requiresFullRefresh || payload.changes.length > MAX_INCREMENTAL_FOLDER_WATCHER_CHANGES
  );
}

function fullRefreshResult(
  images: ImageFile[],
  currentIndex: number,
  currentImagePath: string | null
): FolderWatcherReconciliationResult {
  return {
    images,
    invalidatedPaths: [],
    preferredIndex: currentIndex,
    preferredPath: currentImagePath,
    requiresFullRefresh: true,
  };
}

function applyFolderWatcherChanges(
  images: ImageFile[],
  changes: FolderWatcherChange[],
  currentImagePath: string | null
): FolderWatcherReconciliationDraft {
  const draft: FolderWatcherReconciliationDraft = {
    imagesByPath: new Map(images.map((image) => [pathKey(image.path), image])),
    invalidatedPaths: new Set<string>(),
    preferredPath: currentImagePath,
    currentImagePath,
  };

  for (const change of changes) {
    applyFolderWatcherChange(draft, change);
  }

  return draft;
}

function applyFolderWatcherChange(
  draft: FolderWatcherReconciliationDraft,
  change: FolderWatcherChange
) {
  switch (change.kind) {
    case 'added':
      applyAddedChange(draft, change);
      break;
    case 'removed':
      applyRemovedChange(draft, change);
      break;
    case 'modified':
      applyModifiedChange(draft, change);
      break;
    case 'renamed':
      applyRenamedChange(draft, change);
      break;
  }
}

function reconcileDraft(
  draft: FolderWatcherReconciliationDraft,
  currentIndex: number,
  sortOrder: AppSettings['sortOrder']
): FolderWatcherReconciliationResult {
  const nextImages = sortImages(Array.from(draft.imagesByPath.values()), sortOrder);
  const preferredIndex = resolvePreferredIndex(nextImages, currentIndex, draft.preferredPath);
  const preferredPath = draft.preferredPath;
  const resolvedPreferredPath =
    preferredPath && nextImages.some((image) => isSamePath(image.path, preferredPath))
      ? preferredPath
      : null;

  return {
    images: nextImages,
    invalidatedPaths: Array.from(draft.invalidatedPaths),
    preferredIndex,
    preferredPath: resolvedPreferredPath,
    requiresFullRefresh: false,
  };
}

function applyAddedChange(draft: FolderWatcherReconciliationDraft, change: FolderWatcherChange) {
  if (!change.image) {
    return;
  }

  draft.invalidatedPaths.add(change.image.path);
  draft.imagesByPath.set(pathKey(change.image.path), change.image);
  if (draft.currentImagePath && isSamePath(change.image.path, draft.currentImagePath)) {
    draft.preferredPath = change.image.path;
  }
}

function applyRemovedChange(draft: FolderWatcherReconciliationDraft, change: FolderWatcherChange) {
  draft.imagesByPath.delete(pathKey(change.path));
  draft.invalidatedPaths.add(change.path);
  if (draft.currentImagePath && isSamePath(change.path, draft.currentImagePath)) {
    draft.preferredPath = null;
  }
}

function applyModifiedChange(draft: FolderWatcherReconciliationDraft, change: FolderWatcherChange) {
  draft.invalidatedPaths.add(change.path);
  if (change.image) {
    draft.imagesByPath.set(pathKey(change.image.path), change.image);
  }
}

function applyRenamedChange(draft: FolderWatcherReconciliationDraft, change: FolderWatcherChange) {
  if (change.oldPath) {
    draft.imagesByPath.delete(pathKey(change.oldPath));
    draft.invalidatedPaths.add(change.oldPath);
  }

  draft.invalidatedPaths.add(change.path);
  if (change.image) {
    draft.imagesByPath.set(pathKey(change.image.path), change.image);
  }

  if (
    draft.currentImagePath &&
    change.oldPath &&
    isSamePath(change.oldPath, draft.currentImagePath)
  ) {
    draft.preferredPath = change.image?.path ?? change.path;
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

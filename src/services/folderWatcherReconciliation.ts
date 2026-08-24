import type { ImageFile } from '../types/image';
import type { AppSettings } from '../types/settings';
import { createImageComparator, sortImages } from './imageSorting';
import type { FolderWatcherPayload } from './tauriCommands';

const MAX_INCREMENTAL_FOLDER_WATCHER_CHANGES = 64;
type FolderWatcherChange = FolderWatcherPayload['changes'][number];

interface FolderWatcherReconciliationDraft {
  images: ImageFile[];
  pathIndex: Map<string, bigint>;
  invalidatedPaths: Set<string>;
  preferredPath: string | null;
  preferredIndex: number;
}

export interface FolderWatcherReconciliationOptions {
  payload: FolderWatcherPayload;
  images: ImageFile[];
  currentIndex: number;
  currentImagePath: string | null;
  sortOrder: AppSettings['sortOrder'];
  sortDirection?: AppSettings['sortDirection'];
  randomOrder?: string[] | null;
  /** Normalized catalog index maintained by the viewer across watcher payloads. */
  pathIndex?: Map<string, bigint>;
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
  const {
    payload,
    images,
    currentIndex,
    currentImagePath,
    sortOrder,
    sortDirection = sortOrder === 'name' ? 'ascending' : 'descending',
  } = options;
  if (requiresFullRefresh(payload))
    return fullRefreshResult(images, currentIndex, currentImagePath);

  const baselineImages =
    sortOrder === 'random' || options.pathIndex
      ? [...images]
      : sortImages(images, sortOrder, sortDirection);
  const pathIndex = options.pathIndex ?? buildPathIndex(baselineImages);
  const baselineIndex = currentImagePath
    ? resolveImageIndex(baselineImages, pathIndex, currentImagePath)
    : currentIndex;
  const draft: FolderWatcherReconciliationDraft = {
    images: baselineImages,
    pathIndex,
    invalidatedPaths: new Set<string>(),
    preferredPath: currentImagePath,
    preferredIndex: baselineIndex,
  };
  for (const change of payload.changes) {
    applyFolderWatcherChange(draft, change, sortOrder, sortDirection);
  }

  const preferredImage = draft.images[draft.preferredIndex];
  const preferredPath =
    draft.preferredPath && preferredImage && isSamePath(preferredImage.path, draft.preferredPath)
      ? draft.preferredPath
      : null;
  if (draft.images.length === 0) draft.preferredIndex = -1;
  else if (draft.preferredPath) {
    draft.preferredIndex = resolveImageIndex(draft.images, draft.pathIndex, draft.preferredPath);
  } else {
    draft.preferredIndex = Math.min(Math.max(draft.preferredIndex, 0), draft.images.length - 1);
  }

  return {
    images: draft.images,
    invalidatedPaths: Array.from(draft.invalidatedPaths),
    preferredIndex: draft.preferredIndex,
    preferredPath,
    requiresFullRefresh: false,
  };
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

function applyFolderWatcherChange(
  draft: FolderWatcherReconciliationDraft,
  change: FolderWatcherChange,
  sortOrder: AppSettings['sortOrder'],
  sortDirection: AppSettings['sortDirection']
): void {
  switch (change.kind) {
    case 'added':
      if (change.image) {
        draft.invalidatedPaths.add(change.image.path);
        insertImage(draft, change.image, sortOrder, sortDirection);
      }
      break;
    case 'removed':
      removeImage(draft, change.path);
      draft.invalidatedPaths.add(change.path);
      break;
    case 'modified':
      draft.invalidatedPaths.add(change.path);
      if (change.image) replaceImage(draft, change.path, change.image, sortOrder, sortDirection);
      break;
    case 'renamed':
      if (change.oldPath) draft.invalidatedPaths.add(change.oldPath);
      draft.invalidatedPaths.add(change.path);
      if (change.image)
        replaceImage(draft, change.oldPath ?? change.path, change.image, sortOrder, sortDirection);
      else removeImage(draft, change.oldPath ?? change.path);
      break;
  }
}

function removeImage(draft: FolderWatcherReconciliationDraft, path: string): number {
  const index = resolveImageIndex(draft.images, draft.pathIndex, path);
  if (index < 0) return -1;
  draft.images.splice(index, 1);
  draft.pathIndex.delete(pathKey(path));
  if (draft.preferredPath && isSamePath(path, draft.preferredPath)) {
    draft.preferredPath = null;
    draft.preferredIndex = Math.min(index, draft.images.length - 1);
  } else if (index < draft.preferredIndex) {
    draft.preferredIndex -= 1;
  }
  return index;
}

function replaceImage(
  draft: FolderWatcherReconciliationDraft,
  oldPath: string,
  image: ImageFile,
  sortOrder: AppSettings['sortOrder'],
  sortDirection: AppSettings['sortDirection']
): void {
  const wasPreferred = Boolean(draft.preferredPath && isSamePath(draft.preferredPath, oldPath));
  const oldIndex = removeImage(draft, oldPath);
  if (wasPreferred) draft.preferredPath = image.path;
  if (sortOrder === 'random' && oldIndex >= 0) {
    draft.images.splice(oldIndex, 0, image);
    draft.pathIndex.set(pathKey(image.path), labelBetween(draft, oldIndex));
    if (draft.preferredPath && isSamePath(image.path, draft.preferredPath)) {
      draft.preferredIndex = oldIndex;
    } else if (oldIndex <= draft.preferredIndex) {
      draft.preferredIndex += 1;
    }
    return;
  }
  insertImage(draft, image, sortOrder, sortDirection);
}

function insertImage(
  draft: FolderWatcherReconciliationDraft,
  image: ImageFile,
  sortOrder: AppSettings['sortOrder'],
  sortDirection: AppSettings['sortDirection']
): void {
  const existingIndex = resolveImageIndex(draft.images, draft.pathIndex, image.path);
  if (existingIndex >= 0) {
    draft.images[existingIndex] = image;
    if (draft.preferredPath && isSamePath(image.path, draft.preferredPath)) {
      draft.preferredIndex = existingIndex;
    }
    return;
  }

  const index =
    sortOrder === 'random'
      ? draft.images.length
      : findInsertionIndex(draft.images, image, sortOrder, sortDirection);
  draft.images.splice(index, 0, image);
  draft.pathIndex.set(pathKey(image.path), labelBetween(draft, index));
  if (draft.preferredPath && isSamePath(image.path, draft.preferredPath)) {
    draft.preferredIndex = index;
  } else if (index <= draft.preferredIndex) {
    draft.preferredIndex += 1;
  }
}

function findInsertionIndex(
  images: ImageFile[],
  image: ImageFile,
  sortOrder: Exclude<AppSettings['sortOrder'], 'random'>,
  sortDirection: AppSettings['sortDirection']
): number {
  const compare = createImageComparator(sortOrder, sortDirection === 'ascending' ? 1 : -1);
  let low = 0;
  let high = images.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compare(images[middle], image) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

const ORDER_STEP = 1_000_000n;

function buildPathIndex(images: ImageFile[]): Map<string, bigint> {
  return new Map(images.map((image, index) => [pathKey(image.path), BigInt(index) * ORDER_STEP]));
}

function resolveImageIndex(
  images: ImageFile[],
  pathIndex: Map<string, bigint>,
  path: string
): number {
  const key = pathKey(path);
  const targetLabel = pathIndex.get(key);
  if (targetLabel === undefined) return -1;
  let low = 0;
  let high = images.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const middleLabel = pathIndex.get(pathKey(images[middle].path));
    if (middleLabel === undefined || middleLabel < targetLabel) low = middle + 1;
    else high = middle;
  }
  return low < images.length && pathKey(images[low].path) === key ? low : -1;
}

function labelBetween(draft: FolderWatcherReconciliationDraft, index: number): bigint {
  const previous =
    index > 0 ? draft.pathIndex.get(pathKey(draft.images[index - 1].path)) : undefined;
  const next =
    index + 1 < draft.images.length
      ? draft.pathIndex.get(pathKey(draft.images[index + 1].path))
      : undefined;
  if (previous === undefined && next === undefined) return 0n;
  if (previous === undefined) return next! - ORDER_STEP;
  if (next === undefined) return previous + ORDER_STEP;
  if (next - previous > 1n) return previous + (next - previous) / 2n;

  // The bounded watcher batch can exhaust a gap after many inserts. Re-space once, then continue
  // with a stable label rather than renumbering on every ordinary mutation.
  for (let currentIndex = 0; currentIndex < draft.images.length; currentIndex += 1) {
    draft.pathIndex.set(
      pathKey(draft.images[currentIndex].path),
      BigInt(currentIndex) * ORDER_STEP
    );
  }
  return BigInt(index) * ORDER_STEP;
}

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function isSamePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

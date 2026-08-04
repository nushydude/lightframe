import { create } from 'zustand';
import { getRuntime } from '../services/runtime/runtime';
import type { ImageFile } from '../types/image';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { recordImageSelectedTelemetry } from '../services/performanceTelemetry';
import { overwriteWithCrop, saveRotatedImage } from '../services/tauriCommands';
import {
  getCurationFilterEmptyMessage,
  isFavoriteCuration,
  matchesCurationFilter,
  sortImagesForCurationFilter,
  type CurationFilter,
  type CurationStateSnapshot,
} from '../services/curationFilter';
import {
  clampNormalizedRect,
  type CropAspectRatioPreset,
  type NormalizedCropRect,
  normalizedToIntegerPixelRect,
} from '../services/cropMath';
import { getCropSourceDimensions } from '../services/cropSourceDimensions';

export type ZoomMode = 'fit' | 'fill' | 'actual' | 'custom';
type ViewMode = 'viewer' | 'grid' | 'compare';
type CompareFocusedPane = 'primary' | 'secondary';

const DEFAULT_CROP_RECT: NormalizedCropRect = {
  x: 0.1,
  y: 0.1,
  width: 0.8,
  height: 0.8,
};

function isValidImageIndex(index: number, imageCount: number): boolean {
  return index >= 0 && index < imageCount;
}

type FavoritePathMap = Record<string, boolean>;

function getVisibleImages(
  images: ImageFile[],
  curationFilter: CurationFilter,
  curationStateByPath: Record<string, CurationStateSnapshot>
): ImageFile[] {
  const filteredImages =
    curationFilter === 'all'
      ? images
      : images.filter((image) => matchesCurationFilter(image, curationFilter, curationStateByPath));

  return sortImagesForCurationFilter(filteredImages, curationFilter, curationStateByPath);
}

function clampAdjustment(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function getDefaultSecondaryIndex(primaryIndex: number, imageCount: number): number {
  if (imageCount < 2 || !isValidImageIndex(primaryIndex, imageCount)) {
    return -1;
  }
  if (primaryIndex + 1 < imageCount) {
    return primaryIndex + 1;
  }
  if (primaryIndex - 1 >= 0) {
    return primaryIndex - 1;
  }
  return -1;
}

function resolveCompareIndices(
  imageCount: number,
  currentIndex: number,
  comparePrimaryIndex: number,
  compareSecondaryIndex: number
): { primaryIndex: number; secondaryIndex: number } {
  if (imageCount < 2) {
    return { primaryIndex: -1, secondaryIndex: -1 };
  }

  const primaryIndex = isValidImageIndex(comparePrimaryIndex, imageCount)
    ? comparePrimaryIndex
    : isValidImageIndex(currentIndex, imageCount)
      ? currentIndex
      : 0;
  const secondaryIndex =
    isValidImageIndex(compareSecondaryIndex, imageCount) && compareSecondaryIndex !== primaryIndex
      ? compareSecondaryIndex
      : getDefaultSecondaryIndex(primaryIndex, imageCount);

  return { primaryIndex, secondaryIndex };
}

function resolveCompareStateForImages(
  previousImages: ImageFile[],
  nextImages: ImageFile[],
  currentIndex: number,
  comparePrimaryIndex: number,
  compareSecondaryIndex: number,
  compareFocusedPane: CompareFocusedPane
): {
  comparePrimaryIndex: number;
  compareSecondaryIndex: number;
  compareFocusedPane: CompareFocusedPane;
} {
  const previousPrimaryPath = isValidImageIndex(comparePrimaryIndex, previousImages.length)
    ? previousImages[comparePrimaryIndex].path
    : null;
  const previousSecondaryPath = isValidImageIndex(compareSecondaryIndex, previousImages.length)
    ? previousImages[compareSecondaryIndex].path
    : null;

  const mappedPrimaryIndex = previousPrimaryPath
    ? nextImages.findIndex((image) => image.path === previousPrimaryPath)
    : -1;
  const mappedSecondaryIndex = previousSecondaryPath
    ? nextImages.findIndex((image) => image.path === previousSecondaryPath)
    : -1;
  const { primaryIndex, secondaryIndex } = resolveCompareIndices(
    nextImages.length,
    currentIndex,
    mappedPrimaryIndex,
    mappedSecondaryIndex
  );

  return {
    comparePrimaryIndex: primaryIndex,
    compareSecondaryIndex: secondaryIndex,
    compareFocusedPane:
      compareFocusedPane === 'secondary' && secondaryIndex !== -1 ? 'secondary' : 'primary',
  };
}

function cloneCropRect(rect: NormalizedCropRect | null): NormalizedCropRect | null {
  return rect ? { ...rect } : null;
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function reconcileMarkedPaths(markedPaths: string[], images: ImageFile[]): string[] {
  if (markedPaths.length === 0) {
    return markedPaths;
  }

  const activePathsByKey = new Map(
    images.map((image) => [normalizePathKey(image.path), image.path])
  );
  const reconciledPaths: string[] = [];

  for (const path of markedPaths) {
    const canonicalPath = activePathsByKey.get(normalizePathKey(path));
    if (canonicalPath && !reconciledPaths.includes(canonicalPath)) {
      reconciledPaths.push(canonicalPath);
    }
  }

  return reconciledPaths;
}

function clonePendingSnapshot(snapshot: PendingImageEditSnapshot): PendingImageEditSnapshot {
  return {
    rotationDegrees: snapshot.rotationDegrees,
    cropRect: cloneCropRect(snapshot.cropRect),
    pendingCropPreview: cloneCropRect(snapshot.pendingCropPreview),
  };
}

function hasPendingEdit(snapshot: PendingImageEditSnapshot): boolean {
  return (
    snapshot.rotationDegrees !== 0 ||
    snapshot.cropRect !== null ||
    snapshot.pendingCropPreview !== null
  );
}

function toPendingSnapshot(edit?: PendingImageEdit | null): PendingImageEditSnapshot {
  return {
    rotationDegrees: edit?.rotationDegrees ?? 0,
    cropRect: cloneCropRect(edit?.cropRect ?? null),
    pendingCropPreview: cloneCropRect(edit?.pendingCropPreview ?? null),
  };
}

function getEditFieldsForPath(
  path: string | null,
  pendingEditsByPath: Record<string, PendingImageEdit>
) {
  const edit = path ? pendingEditsByPath[path] : undefined;
  return {
    rotation: edit?.rotationDegrees ?? 0,
    cropRect: cloneCropRect(edit?.cropRect ?? null),
    pendingCropPreview: cloneCropRect(edit?.pendingCropPreview ?? null),
  };
}

interface PendingImageEditSnapshot {
  rotationDegrees: number;
  cropRect: NormalizedCropRect | null;
  pendingCropPreview: NormalizedCropRect | null;
}

interface PendingImageEdit extends PendingImageEditSnapshot {
  updatedAt: number;
  history: PendingImageEditSnapshot[];
}

interface ViewerState {
  // Image state
  currentImagePath: string | null;
  folderPath: string | null;
  allImages: ImageFile[];
  images: ImageFile[];
  currentIndex: number;
  isFolderScanning: boolean;
  cacheBuster: number;
  loadGeneration: number;
  pendingEditsByPath: Record<string, PendingImageEdit>;

  // Display state
  isFullscreen: boolean;
  defaultZoomMode: ZoomMode;
  zoomMode: ZoomMode;
  zoomLevel: number;
  panX: number;
  panY: number;
  rotation: number; // In degrees
  imageSmoothing: number;
  imageSharpening: number;
  isCropMode: boolean;
  cropRect: NormalizedCropRect | null;
  pendingCropPreview: NormalizedCropRect | null;
  cropAspectRatio: CropAspectRatioPreset;

  // Slideshow state
  isSlideshowActive: boolean;
  isSlideshowPaused: boolean;

  // UI state
  showControls: boolean;
  showSettings: boolean;
  showCommandPalette: boolean;
  showPerformanceTelemetry: boolean;
  errorMessage: string | null;
  viewMode: ViewMode;
  showOnlyFavorites: boolean;
  curationFilter: CurationFilter;
  favoritePaths: FavoritePathMap;
  markedPaths: string[];
  curationStateByPath: Record<string, CurationStateSnapshot>;
  favoriteFilterReturnPath: string | null;
  curationFilterReturnPath: string | null;
  comparePrimaryIndex: number;
  compareSecondaryIndex: number;
  compareFocusedPane: CompareFocusedPane;
  isCompareZoomLocked: boolean;

  // Actions
  setCurrentImage: (path: string, index: number) => void;
  setImages: (images: ImageFile[]) => void;
  setShowOnlyFavorites: (showOnlyFavorites: boolean) => void;
  toggleMarkedPath: (path: string) => void;
  clearMarkedPaths: () => void;
  markAllVisibleImages: () => void;
  setMarkedPaths: (paths: string[]) => void;
  setCurationFilter: (filter: CurationFilter) => void;
  prepareCurationFilter: (filter: CurationFilter) => void;
  syncFavoriteFilter: (
    curationByPath: Record<string, CurationStateSnapshot>,
    favoritePaths?: ReadonlySet<string>
  ) => void;
  setFolderPath: (path: string) => void;
  setFolderScanning: (scanning: boolean) => void;
  setCurrentIndex: (index: number, options?: { zoomMode?: ZoomMode }) => void;
  navigateNext: (loop?: boolean) => boolean;
  navigatePrev: (loop?: boolean) => boolean;
  navigateFirst: () => void;
  navigateLast: () => void;
  removeImage: (index: number) => void;
  removeImagesByPaths: (paths: string[]) => void;

  setFullscreen: (fs: boolean) => void;
  setDefaultZoomMode: (mode: ZoomMode) => void;
  setZoomMode: (mode: ZoomMode) => void;
  setZoomLevel: (level: number) => void;
  setPan: (x: number, y: number) => void;
  resetZoom: () => void;
  setImageSmoothing: (value: number) => void;
  setImageSharpening: (value: number) => void;
  resetImageAdjustments: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  rotateClockwise: () => void;
  rotateCounterClockwise: () => void;
  enterCropMode: () => void;
  exitCropMode: () => void;
  updateCropRect: (rect: NormalizedCropRect | null) => void;
  setCropAspectRatio: (ratio: CropAspectRatioPreset) => void;
  resetCrop: () => void;
  applyCropPreview: () => void;
  clearCropPreview: () => void;
  clearPendingEdits: (path: string) => void;
  clearAllPendingEdits: () => void;
  commitPendingEdits: (path: string) => Promise<void>;
  undoLastEdit: (path: string) => void;

  startSlideshow: () => void;
  stopSlideshow: () => void;
  toggleSlideshowPause: () => void;

  setShowControls: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setShowCommandPalette: (show: boolean) => void;
  setShowPerformanceTelemetry: (show: boolean) => void;
  setError: (msg: string | null) => void;
  saveRotation: () => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  enterCompareMode: () => boolean;
  exitCompareMode: () => void;
  switchCompareFocus: () => void;
  moveCompareFocusedCandidate: (direction: -1 | 1) => boolean;
  promoteFocusedComparePane: () => boolean;
  setCompareZoomLocked: (locked: boolean) => void;
  beginLoadGeneration: () => number;
  reset: () => void;
}

const initialState = {
  currentImagePath: null,
  folderPath: null,
  allImages: [],
  images: [],
  currentIndex: -1,
  isFolderScanning: false,
  pendingEditsByPath: {},
  isFullscreen: false,
  defaultZoomMode: 'fit' as ZoomMode,
  zoomMode: 'fit' as ZoomMode,
  zoomLevel: 1,
  panX: 0,
  panY: 0,
  rotation: 0,
  imageSmoothing: 0,
  imageSharpening: 0,
  isCropMode: false,
  cropRect: null,
  pendingCropPreview: null,
  cropAspectRatio: 'free' as CropAspectRatioPreset,
  isSlideshowActive: false,
  isSlideshowPaused: false,
  showControls: true,
  showSettings: false,
  showCommandPalette: false,
  showPerformanceTelemetry: false,
  errorMessage: null,
  cacheBuster: 0,
  loadGeneration: 0,
  viewMode: 'viewer' as ViewMode,
  showOnlyFavorites: false,
  curationFilter: 'all' as CurationFilter,
  favoritePaths: {},
  markedPaths: [],
  curationStateByPath: {},
  favoriteFilterReturnPath: null,
  curationFilterReturnPath: null,
  comparePrimaryIndex: -1,
  compareSecondaryIndex: -1,
  compareFocusedPane: 'secondary' as CompareFocusedPane,
  isCompareZoomLocked: false,
};

function uniqueMarkedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const uniquePaths: string[] = [];
  for (const path of paths) {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      continue;
    }

    const normalizedPath = normalizePathKey(trimmedPath);
    if (seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    uniquePaths.push(trimmedPath);
  }

  return uniquePaths;
}

function compareZoomResetState(): Pick<ViewerState, 'zoomMode' | 'zoomLevel' | 'panX' | 'panY'> {
  return {
    zoomMode: 'fit',
    zoomLevel: 1,
    panX: 0,
    panY: 0,
  };
}

function getPendingEditForCommit(
  state: ViewerState,
  targetPath: string
): PendingImageEdit | undefined {
  const pendingEdit = state.pendingEditsByPath[targetPath];
  if (pendingEdit) return pendingEdit;
  if (state.currentImagePath !== targetPath) return undefined;

  return {
    rotationDegrees: state.rotation,
    cropRect: cloneCropRect(state.cropRect),
    pendingCropPreview: cloneCropRect(state.pendingCropPreview),
    updatedAt: Date.now(),
    history: [],
  };
}

async function savePendingEdit(
  targetPath: string,
  pendingEdit: PendingImageEdit
): Promise<boolean> {
  if (pendingEdit.cropRect) {
    return overwritePendingCrop(targetPath, pendingEdit.cropRect, pendingEdit.rotationDegrees);
  }

  if (pendingEdit.rotationDegrees !== 0) {
    await saveRotatedImage(targetPath, pendingEdit.rotationDegrees);
  }

  return true;
}

async function overwritePendingCrop(
  targetPath: string,
  cropRect: NormalizedCropRect,
  rotationDegrees: number
): Promise<boolean> {
  const fileName = targetPath.replace(/\\/g, '/').split('/').pop() || targetPath;
  const confirmed = await getRuntime().confirm(
    `Overwrite the original image with this crop?\n\n${fileName}\n\nThis modifies the source file.`,
    { title: 'Overwrite Cropped Image', kind: 'warning' }
  );
  if (!confirmed) return false;

  const dimensions = await getCropSourceDimensions(targetPath);
  if (!dimensions) {
    throw new Error('Unable to determine image dimensions for pending crop save.');
  }

  const { width, height } = dimensions;
  await overwriteWithCrop(
    targetPath,
    normalizedToIntegerPixelRect(cropRect, width, height),
    rotationDegrees
  );
  return true;
}

function getCommittedEditState(
  currentState: ViewerState,
  targetPath: string
): Partial<ViewerState> {
  const nextPendingEdits = { ...currentState.pendingEditsByPath };
  delete nextPendingEdits[targetPath];

  if (currentState.currentImagePath !== targetPath) {
    return { pendingEditsByPath: nextPendingEdits };
  }

  return {
    pendingEditsByPath: nextPendingEdits,
    rotation: 0,
    cropRect: null,
    pendingCropPreview: null,
    isCropMode: false,
    cacheBuster: Date.now(),
    errorMessage: null,
  };
}

function getFilteredImagesState(
  state: ViewerState,
  nextAllImages: ImageFile[],
  nextCurationFilter: CurationFilter,
  nextFavoritePaths = state.favoritePaths,
  nextCurationStateByPath = state.curationStateByPath,
  preferredCurrentPath = state.currentImagePath
): Partial<ViewerState> {
  const nextImages = getVisibleImages(nextAllImages, nextCurationFilter, nextCurationStateByPath);
  const compareState = resolveCompareStateForImages(
    state.images,
    nextImages,
    state.currentIndex,
    state.comparePrimaryIndex,
    state.compareSecondaryIndex,
    state.compareFocusedPane
  );
  const updates: Partial<ViewerState> = {
    allImages: nextAllImages,
    images: nextImages,
    showOnlyFavorites: nextCurationFilter === 'favorites',
    curationFilter: nextCurationFilter,
    favoritePaths: nextFavoritePaths,
    markedPaths: reconcileMarkedPaths(state.markedPaths, nextAllImages),
    curationStateByPath: nextCurationStateByPath,
    comparePrimaryIndex: compareState.comparePrimaryIndex,
    compareSecondaryIndex: compareState.compareSecondaryIndex,
    compareFocusedPane: compareState.compareFocusedPane,
  };

  if (nextImages.length === 0) {
    return {
      ...updates,
      currentImagePath: null,
      currentIndex: -1,
      viewMode: state.viewMode === 'compare' ? 'viewer' : state.viewMode,
    };
  }

  const matchedIndex = preferredCurrentPath
    ? nextImages.findIndex((image) => image.path === preferredCurrentPath)
    : -1;
  const nextIndex =
    matchedIndex >= 0
      ? matchedIndex
      : Math.min(Math.max(state.currentIndex, 0), nextImages.length - 1);
  const nextPath = nextImages[nextIndex]?.path ?? null;
  const editFields = getEditFieldsForPath(nextPath, state.pendingEditsByPath);

  return {
    ...updates,
    currentIndex: nextIndex,
    currentImagePath: nextPath,
    rotation: editFields.rotation,
    cropRect: editFields.cropRect,
    pendingCropPreview: editFields.pendingCropPreview,
    isCropMode: false,
    viewMode:
      state.viewMode === 'compare' && compareState.compareSecondaryIndex === -1
        ? 'viewer'
        : state.viewMode,
  };
}

function getFavoriteSafeImagesState(
  state: ViewerState,
  nextAllImages: ImageFile[],
  nextCurationFilter: CurationFilter,
  nextFavoritePaths = state.favoritePaths,
  nextCurationStateByPath = state.curationStateByPath,
  preferredCurrentPath = state.currentImagePath
): Partial<ViewerState> {
  const filteredState = getFilteredImagesState(
    state,
    nextAllImages,
    nextCurationFilter,
    nextFavoritePaths,
    nextCurationStateByPath,
    preferredCurrentPath
  );

  if (
    nextCurationFilter === 'all' ||
    nextAllImages.length === 0 ||
    (filteredState.images?.length ?? 0) > 0
  ) {
    return filteredState;
  }

  const emptyMessage = getCurationFilterEmptyMessage(nextCurationFilter);
  return {
    ...getFilteredImagesState(
      state,
      nextAllImages,
      'all',
      nextFavoritePaths,
      nextCurationStateByPath
    ),
    errorMessage: emptyMessage,
  };
}

export const useViewerStore = create<ViewerState>((set, get) => {
  const syncCurrentPendingEdit = (
    recipe: (
      draft: PendingImageEditSnapshot,
      existing: PendingImageEdit | undefined
    ) => PendingImageEditSnapshot,
    pushHistory = false
  ) => {
    const { currentImagePath } = get();
    if (!currentImagePath) {
      return;
    }

    set((state) => {
      const existing = state.pendingEditsByPath[currentImagePath];
      const draft = recipe(toPendingSnapshot(existing), existing);
      const nextPendingEdits = { ...state.pendingEditsByPath };

      if (hasPendingEdit(draft)) {
        nextPendingEdits[currentImagePath] = {
          rotationDegrees: draft.rotationDegrees,
          cropRect: cloneCropRect(draft.cropRect),
          pendingCropPreview: cloneCropRect(draft.pendingCropPreview),
          updatedAt: Date.now(),
          history: pushHistory
            ? [...(existing?.history ?? []), clonePendingSnapshot(toPendingSnapshot(existing))]
            : (existing?.history ?? []),
        };
      } else {
        delete nextPendingEdits[currentImagePath];
      }

      return {
        pendingEditsByPath: nextPendingEdits,
        rotation: draft.rotationDegrees,
        cropRect: cloneCropRect(draft.cropRect),
        pendingCropPreview: cloneCropRect(draft.pendingCropPreview),
      };
    });
  };

  return {
    ...initialState,

    setCurrentImage: (path, index) => {
      const { defaultZoomMode, pendingEditsByPath } = get();
      const editFields = getEditFieldsForPath(path, pendingEditsByPath);
      recordImageSelectedTelemetry(path);
      set({
        currentImagePath: path,
        currentIndex: index,
        zoomMode: defaultZoomMode,
        zoomLevel: 1,
        panX: 0,
        panY: 0,
        rotation: editFields.rotation,
        isCropMode: false,
        cropRect: editFields.cropRect,
        pendingCropPreview: editFields.pendingCropPreview,
        cropAspectRatio: 'free',
        errorMessage: null,
      });
    },

    setImages: (images) =>
      set((state) => getFavoriteSafeImagesState(state, images, state.curationFilter)),

    setShowOnlyFavorites: (showOnlyFavorites) =>
      get().setCurationFilter(showOnlyFavorites ? 'favorites' : 'all'),

    toggleMarkedPath: (path) =>
      set((state) => {
        const normalizedPath = normalizePathKey(path);
        const existingIndex = state.markedPaths.findIndex(
          (value) => normalizePathKey(value) === normalizedPath
        );

        return {
          markedPaths:
            existingIndex >= 0
              ? state.markedPaths.filter((_, index) => index !== existingIndex)
              : [...state.markedPaths, path],
        };
      }),

    clearMarkedPaths: () => set({ markedPaths: [] }),

    markAllVisibleImages: () =>
      set((state) => ({
        markedPaths: state.images.map((image) => image.path),
      })),

    setMarkedPaths: (paths) =>
      set((state) => ({
        markedPaths: reconcileMarkedPaths(uniqueMarkedPaths(paths), state.images),
      })),

    prepareCurationFilter: (filter) =>
      set({
        curationFilter: filter,
        showOnlyFavorites: filter === 'favorites',
        favoriteFilterReturnPath: null,
        curationFilterReturnPath: null,
        errorMessage: null,
      }),

    setCurationFilter: (filter) =>
      set((state) => {
        if (filter === state.curationFilter) {
          return {};
        }

        const sourceImages = state.allImages.length > 0 ? state.allImages : state.images;
        const preferredCurrentPath =
          filter === 'all'
            ? (state.curationFilterReturnPath ?? state.currentImagePath)
            : state.currentImagePath;
        const filterState = getFavoriteSafeImagesState(
          state,
          sourceImages,
          filter,
          state.favoritePaths,
          state.curationStateByPath,
          preferredCurrentPath
        );

        return {
          ...filterState,
          favoriteFilterReturnPath:
            filterState.curationFilter === 'favorites' ? state.currentImagePath : null,
          curationFilterReturnPath:
            filterState.curationFilter !== 'all' ? state.currentImagePath : null,
        };
      }),

    syncFavoriteFilter: (curationByPath, favoritePaths) =>
      set((state) => {
        const nextFavoritePaths = favoritePaths
          ? Object.fromEntries(Array.from(favoritePaths, (path) => [path, true]))
          : Object.fromEntries(
              Object.entries(curationByPath)
                .filter(([, curation]) => isFavoriteCuration(curation))
                .map(([path]) => [path, true])
            );
        if (state.curationFilter === 'all') {
          return {
            favoritePaths: nextFavoritePaths,
            curationStateByPath: curationByPath,
          };
        }

        const sourceImages = state.allImages.length > 0 ? state.allImages : state.images;
        const preferredCurrentPath =
          state.curationFilter === 'favorites'
            ? state.currentImagePath
            : (state.curationFilterReturnPath ?? state.currentImagePath);
        const filterState = getFavoriteSafeImagesState(
          state,
          sourceImages,
          state.curationFilter,
          nextFavoritePaths,
          curationByPath,
          preferredCurrentPath
        );

        return {
          ...filterState,
          favoriteFilterReturnPath:
            filterState.curationFilter === 'favorites' ? state.favoriteFilterReturnPath : null,
          curationFilterReturnPath:
            filterState.curationFilter !== 'all' ? state.curationFilterReturnPath : null,
        };
      }),

    setFolderPath: (path) => set({ folderPath: path }),

    setFolderScanning: (scanning) => set({ isFolderScanning: scanning }),

    setCurrentIndex: (index: number, options?: { zoomMode?: ZoomMode }) => {
      const { images, defaultZoomMode } = get();
      if (index < 0 || index >= images.length) return;

      set((state) => {
        const path = images[index].path;
        recordImageSelectedTelemetry(path);
        const editFields = getEditFieldsForPath(path, state.pendingEditsByPath);
        const zoomMode = options?.zoomMode ?? (state.isSlideshowActive ? 'fit' : defaultZoomMode);
        const updates: Partial<ViewerState> = {
          currentIndex: index,
          currentImagePath: path,
          zoomMode,
          zoomLevel: 1,
          panX: 0,
          panY: 0,
          rotation: editFields.rotation,
          isCropMode: false,
          cropRect: editFields.cropRect,
          pendingCropPreview: editFields.pendingCropPreview,
          cropAspectRatio: 'free',
          errorMessage: null,
        };

        if (state.viewMode === 'compare') {
          const compareState = resolveCompareStateForImages(
            state.images,
            state.images,
            index,
            index,
            state.compareSecondaryIndex,
            state.compareFocusedPane
          );
          updates.comparePrimaryIndex = compareState.comparePrimaryIndex;
          updates.compareSecondaryIndex = compareState.compareSecondaryIndex;
          updates.compareFocusedPane = compareState.compareFocusedPane;
        }

        return updates;
      });
    },

    navigateNext: (loop = false) => {
      const { currentIndex, images } = get();
      if (images.length === 0) return false;
      if (currentIndex < images.length - 1) {
        get().setCurrentIndex(currentIndex + 1);
        return true;
      } else if (loop) {
        get().setCurrentIndex(0);
        return true;
      }
      return false;
    },

    navigatePrev: (loop = false) => {
      const { currentIndex, images } = get();
      if (images.length === 0) return false;
      if (currentIndex > 0) {
        get().setCurrentIndex(currentIndex - 1);
        return true;
      } else if (loop) {
        get().setCurrentIndex(images.length - 1);
        return true;
      }
      return false;
    },

    navigateFirst: () => {
      const { images } = get();
      if (images.length > 0) {
        get().setCurrentIndex(0);
      }
    },

    navigateLast: () => {
      const { images } = get();
      if (images.length > 0) {
        get().setCurrentIndex(images.length - 1);
      }
    },

    removeImage: (index) => {
      const { images } = get();
      if (index < 0 || index >= images.length) return;

      const removedPath = images[index]?.path;
      if (removedPath) {
        get().removeImagesByPaths([removedPath]);
      }
    },

    removeImagesByPaths: (paths) => {
      const normalizedRemovedPaths = new Set(
        paths
          .map((path) => path.trim())
          .filter(Boolean)
          .map(normalizePathKey)
      );
      if (normalizedRemovedPaths.size === 0) {
        return;
      }

      const state = get();
      const sourceImages = state.allImages.length > 0 ? state.allImages : state.images;
      const newAllImages = sourceImages.filter(
        (image) => !normalizedRemovedPaths.has(normalizePathKey(image.path))
      );
      if (newAllImages.length === sourceImages.length) {
        return;
      }

      for (const path of paths) {
        const trimmedPath = path.trim();
        if (!trimmedPath) {
          continue;
        }

        invalidateImageAsset(trimmedPath);
        invalidateThumbnail(trimmedPath);
      }

      if (newAllImages.length === 0) {
        get().reset();
        return;
      }

      set((currentState) => {
        const nextPendingEdits = { ...currentState.pendingEditsByPath };
        for (const path of Object.keys(nextPendingEdits)) {
          if (normalizedRemovedPaths.has(normalizePathKey(path))) {
            delete nextPendingEdits[path];
          }
        }

        return {
          ...getFavoriteSafeImagesState(currentState, newAllImages, currentState.curationFilter),
          markedPaths: currentState.markedPaths.filter(
            (path) => !normalizedRemovedPaths.has(normalizePathKey(path))
          ),
          pendingEditsByPath: nextPendingEdits,
        };
      });
    },

    setFullscreen: (fs) => set({ isFullscreen: fs }),
    setDefaultZoomMode: (mode) => set({ defaultZoomMode: mode }),

    setZoomMode: (mode) => {
      const updates: Partial<ViewerState> = { zoomMode: mode, panX: 0, panY: 0 };
      if (mode === 'actual') updates.zoomLevel = 1;
      if (mode === 'fit') updates.zoomLevel = 1;
      set(updates);
    },

    setZoomLevel: (level) => {
      const clamped = Math.max(0.1, Math.min(20, level));
      set({ zoomLevel: clamped, zoomMode: 'custom' });
    },

    setPan: (x, y) => set({ panX: x, panY: y }),

    resetZoom: () => set({ zoomMode: 'fit', zoomLevel: 1, panX: 0, panY: 0 }),

    setImageSmoothing: (value) => set({ imageSmoothing: clampAdjustment(value) }),

    setImageSharpening: (value) => set({ imageSharpening: clampAdjustment(value) }),

    resetImageAdjustments: () => set({ imageSmoothing: 0, imageSharpening: 0 }),

    zoomIn: () => {
      const { zoomLevel } = get();
      const newLevel = Math.min(20, zoomLevel * 1.25);
      set({ zoomLevel: newLevel, zoomMode: 'custom' });
    },

    zoomOut: () => {
      const { zoomLevel } = get();
      const newLevel = Math.max(0.1, zoomLevel / 1.25);
      set({ zoomLevel: newLevel, zoomMode: 'custom' });
    },

    rotateClockwise: () => {
      const { rotation } = get();
      set({ isCropMode: false });
      syncCurrentPendingEdit(
        () => ({
          rotationDegrees: (rotation + 90) % 360,
          cropRect: null,
          pendingCropPreview: null,
        }),
        true
      );
    },

    rotateCounterClockwise: () => {
      const { rotation } = get();
      set({ isCropMode: false });
      syncCurrentPendingEdit(
        () => ({
          rotationDegrees: (rotation - 90 + 360) % 360,
          cropRect: null,
          pendingCropPreview: null,
        }),
        true
      );
    },

    enterCropMode: () => {
      const { cropRect, pendingCropPreview } = get();
      set({
        isCropMode: true,
        cropRect: clampNormalizedRect(cropRect ?? pendingCropPreview ?? DEFAULT_CROP_RECT),
        pendingCropPreview: null,
      });
    },

    exitCropMode: () => set({ isCropMode: false, cropRect: null }),

    updateCropRect: (rect) => {
      const nextRect = rect ? clampNormalizedRect(rect) : null;
      set({ cropRect: nextRect });
      syncCurrentPendingEdit((draft) => ({
        ...draft,
        cropRect: cloneCropRect(nextRect),
      }));
    },

    setCropAspectRatio: (ratio) => set({ cropAspectRatio: ratio }),

    resetCrop: () => {
      const resetRect = clampNormalizedRect(DEFAULT_CROP_RECT);
      set({
        cropRect: resetRect,
        pendingCropPreview: null,
      });
      syncCurrentPendingEdit((draft) => ({
        ...draft,
        cropRect: cloneCropRect(resetRect),
        pendingCropPreview: null,
      }));
    },

    applyCropPreview: () => {
      const { cropRect } = get();
      if (!cropRect) return;
      const previewRect = clampNormalizedRect(cropRect);
      set({
        pendingCropPreview: previewRect,
        isCropMode: false,
      });
      syncCurrentPendingEdit(
        (draft) => ({
          ...draft,
          cropRect: cloneCropRect(previewRect),
          pendingCropPreview: cloneCropRect(previewRect),
        }),
        true
      );
    },

    clearCropPreview: () => {
      set({ pendingCropPreview: null });
      syncCurrentPendingEdit((draft) => ({
        ...draft,
        pendingCropPreview: null,
      }));
    },

    clearPendingEdits: (path) =>
      set((state) => {
        const nextPendingEdits = { ...state.pendingEditsByPath };
        delete nextPendingEdits[path];

        if (state.currentImagePath !== path) {
          return { pendingEditsByPath: nextPendingEdits };
        }

        return {
          pendingEditsByPath: nextPendingEdits,
          rotation: 0,
          cropRect: null,
          pendingCropPreview: null,
          isCropMode: false,
        };
      }),

    clearAllPendingEdits: () =>
      set({
        pendingEditsByPath: {},
        rotation: 0,
        cropRect: null,
        pendingCropPreview: null,
        isCropMode: false,
      }),

    commitPendingEdits: async (path) => {
      const state = get();
      const targetPath = path || state.currentImagePath;
      if (!targetPath) return;

      const pendingEdit = getPendingEditForCommit(state, targetPath);
      if (!pendingEdit || !hasPendingEdit(pendingEdit)) return;

      try {
        const didCommit = await savePendingEdit(targetPath, pendingEdit);
        if (!didCommit) return;

        invalidateImageAsset(targetPath);
        invalidateThumbnail(targetPath);
        set((currentState) => getCommittedEditState(currentState, targetPath));
      } catch (err) {
        set({ errorMessage: `Failed to save edits: ${err}` });
      }
    },

    undoLastEdit: (path) =>
      set((state) => {
        const existing = state.pendingEditsByPath[path];
        if (!existing || existing.history.length === 0) {
          return {};
        }

        const previousSnapshot = existing.history[existing.history.length - 1];
        const remainingHistory = existing.history.slice(0, -1);
        const nextPendingEdits = { ...state.pendingEditsByPath };

        if (hasPendingEdit(previousSnapshot)) {
          nextPendingEdits[path] = {
            rotationDegrees: previousSnapshot.rotationDegrees,
            cropRect: cloneCropRect(previousSnapshot.cropRect),
            pendingCropPreview: cloneCropRect(previousSnapshot.pendingCropPreview),
            updatedAt: Date.now(),
            history: remainingHistory,
          };
        } else {
          delete nextPendingEdits[path];
        }

        if (state.currentImagePath !== path) {
          return { pendingEditsByPath: nextPendingEdits };
        }

        return {
          pendingEditsByPath: nextPendingEdits,
          rotation: previousSnapshot.rotationDegrees,
          cropRect: cloneCropRect(previousSnapshot.cropRect),
          pendingCropPreview: cloneCropRect(previousSnapshot.pendingCropPreview),
          isCropMode: false,
        };
      }),

    startSlideshow: () =>
      set({
        isSlideshowActive: true,
        isSlideshowPaused: false,
        zoomMode: 'fit',
        zoomLevel: 1,
        panX: 0,
        panY: 0,
      }),

    stopSlideshow: () => set({ isSlideshowActive: false, isSlideshowPaused: false }),

    toggleSlideshowPause: () => {
      const { isSlideshowPaused } = get();
      set({ isSlideshowPaused: !isSlideshowPaused });
    },

    setShowControls: (show) => set({ showControls: show }),
    setShowSettings: (show) => set({ showSettings: show }),
    setShowCommandPalette: (show) => set({ showCommandPalette: show }),
    setShowPerformanceTelemetry: (show) => set({ showPerformanceTelemetry: show }),
    setError: (msg) => set({ errorMessage: msg }),

    saveRotation: async () => {
      const { currentImagePath } = get();
      if (!currentImagePath) return;
      await get().commitPendingEdits(currentImagePath);
    },

    setViewMode: (mode) =>
      set((state) => {
        if (mode === 'grid') {
          return {
            viewMode: mode,
            isCropMode: false,
            cropRect: null,
            pendingCropPreview: null,
          };
        }

        if (mode === 'compare') {
          const compareState = resolveCompareStateForImages(
            state.images,
            state.images,
            state.currentIndex,
            state.currentIndex,
            state.compareSecondaryIndex,
            'secondary'
          );
          if (compareState.compareSecondaryIndex === -1) {
            return {};
          }

          const primaryPath = state.images[compareState.comparePrimaryIndex]?.path ?? null;
          const editFields = getEditFieldsForPath(primaryPath, state.pendingEditsByPath);
          return {
            viewMode: mode,
            currentIndex: compareState.comparePrimaryIndex,
            currentImagePath: primaryPath,
            comparePrimaryIndex: compareState.comparePrimaryIndex,
            compareSecondaryIndex: compareState.compareSecondaryIndex,
            compareFocusedPane: compareState.compareFocusedPane,
            isCropMode: false,
            cropRect: editFields.cropRect,
            pendingCropPreview: editFields.pendingCropPreview,
            rotation: editFields.rotation,
          };
        }

        const editFields = getEditFieldsForPath(state.currentImagePath, state.pendingEditsByPath);
        return {
          viewMode: mode,
          isCropMode: false,
          cropRect: editFields.cropRect,
          pendingCropPreview: editFields.pendingCropPreview,
          rotation: editFields.rotation,
          ...(state.viewMode === 'compare' ? compareZoomResetState() : {}),
        };
      }),

    enterCompareMode: () => {
      const state = get();
      const compareState = resolveCompareStateForImages(
        state.images,
        state.images,
        state.currentIndex,
        state.currentIndex,
        state.compareSecondaryIndex,
        'secondary'
      );
      if (compareState.compareSecondaryIndex === -1) {
        return false;
      }

      const primaryPath = state.images[compareState.comparePrimaryIndex]?.path ?? null;
      const editFields = getEditFieldsForPath(primaryPath, state.pendingEditsByPath);
      set({
        viewMode: 'compare',
        currentIndex: compareState.comparePrimaryIndex,
        currentImagePath: primaryPath,
        comparePrimaryIndex: compareState.comparePrimaryIndex,
        compareSecondaryIndex: compareState.compareSecondaryIndex,
        compareFocusedPane: compareState.compareFocusedPane,
        isCropMode: false,
        cropRect: editFields.cropRect,
        pendingCropPreview: editFields.pendingCropPreview,
        rotation: editFields.rotation,
        ...compareZoomResetState(),
      });
      return true;
    },

    exitCompareMode: () =>
      set((state) => {
        if (state.viewMode !== 'compare') {
          return {};
        }

        const { primaryIndex } = resolveCompareIndices(
          state.images.length,
          state.currentIndex,
          state.comparePrimaryIndex,
          state.compareSecondaryIndex
        );
        const nextCurrentIndex = isValidImageIndex(primaryIndex, state.images.length)
          ? primaryIndex
          : state.currentIndex;
        const nextCurrentPath = isValidImageIndex(nextCurrentIndex, state.images.length)
          ? state.images[nextCurrentIndex].path
          : null;
        const editFields = getEditFieldsForPath(nextCurrentPath, state.pendingEditsByPath);
        return {
          viewMode: 'viewer',
          currentIndex: nextCurrentIndex,
          currentImagePath: nextCurrentPath,
          comparePrimaryIndex: nextCurrentIndex,
          compareSecondaryIndex: isValidImageIndex(nextCurrentIndex, state.images.length)
            ? getDefaultSecondaryIndex(nextCurrentIndex, state.images.length)
            : -1,
          compareFocusedPane: 'secondary',
          isCropMode: false,
          cropRect: editFields.cropRect,
          pendingCropPreview: editFields.pendingCropPreview,
          rotation: editFields.rotation,
        };
      }),

    switchCompareFocus: () =>
      set((state) => {
        if (state.viewMode !== 'compare' || state.compareSecondaryIndex === -1) {
          return {};
        }

        return {
          compareFocusedPane: state.compareFocusedPane === 'primary' ? 'secondary' : 'primary',
        };
      }),

    moveCompareFocusedCandidate: (direction) => {
      const state = get();
      if (state.viewMode !== 'compare' || state.images.length < 2) {
        return false;
      }

      const focusedIsPrimary = state.compareFocusedPane === 'primary';
      const focusedIndex = focusedIsPrimary
        ? state.comparePrimaryIndex
        : state.compareSecondaryIndex;
      const otherIndex = focusedIsPrimary ? state.compareSecondaryIndex : state.comparePrimaryIndex;

      if (!isValidImageIndex(focusedIndex, state.images.length)) {
        return false;
      }

      let nextIndex = focusedIndex + direction;
      while (isValidImageIndex(nextIndex, state.images.length) && nextIndex === otherIndex) {
        nextIndex += direction;
      }

      if (!isValidImageIndex(nextIndex, state.images.length)) {
        return false;
      }

      if (focusedIsPrimary) {
        const nextPath = state.images[nextIndex].path;
        const editFields = getEditFieldsForPath(nextPath, state.pendingEditsByPath);
        set({
          comparePrimaryIndex: nextIndex,
          currentIndex: nextIndex,
          currentImagePath: nextPath,
          isCropMode: false,
          cropRect: editFields.cropRect,
          pendingCropPreview: editFields.pendingCropPreview,
          rotation: editFields.rotation,
          ...(state.isCompareZoomLocked ? {} : compareZoomResetState()),
        });
      } else {
        set({
          compareSecondaryIndex: nextIndex,
          ...(state.isCompareZoomLocked ? {} : compareZoomResetState()),
        });
      }

      return true;
    },

    promoteFocusedComparePane: () => {
      const state = get();
      if (state.viewMode !== 'compare' || state.compareSecondaryIndex === -1) {
        return false;
      }

      const focusedIndex =
        state.compareFocusedPane === 'primary'
          ? state.comparePrimaryIndex
          : state.compareSecondaryIndex;
      if (!isValidImageIndex(focusedIndex, state.images.length)) {
        return false;
      }

      const nextPrimaryIndex = focusedIndex;
      const nextSecondaryIndex =
        state.compareFocusedPane === 'secondary'
          ? state.comparePrimaryIndex
          : state.compareSecondaryIndex;
      const resolvedSecondaryIndex =
        nextSecondaryIndex !== nextPrimaryIndex
          ? nextSecondaryIndex
          : getDefaultSecondaryIndex(nextPrimaryIndex, state.images.length);

      const nextPrimaryPath = state.images[nextPrimaryIndex].path;
      const editFields = getEditFieldsForPath(nextPrimaryPath, state.pendingEditsByPath);
      set({
        viewMode: 'compare',
        currentIndex: nextPrimaryIndex,
        currentImagePath: nextPrimaryPath,
        comparePrimaryIndex: nextPrimaryIndex,
        compareSecondaryIndex: resolvedSecondaryIndex,
        compareFocusedPane: 'primary',
        isCropMode: false,
        cropRect: editFields.cropRect,
        pendingCropPreview: editFields.pendingCropPreview,
        rotation: editFields.rotation,
        ...(state.isCompareZoomLocked ? {} : compareZoomResetState()),
      });

      return true;
    },

    setCompareZoomLocked: (locked) => set({ isCompareZoomLocked: locked }),

    beginLoadGeneration: () => {
      const nextGeneration = get().loadGeneration + 1;
      set({ loadGeneration: nextGeneration });
      return nextGeneration;
    },

    reset: () =>
      set((state) => ({
        ...initialState,
        defaultZoomMode: state.defaultZoomMode,
        showPerformanceTelemetry: state.showPerformanceTelemetry,
        loadGeneration: state.loadGeneration + 1,
      })),
  };
});

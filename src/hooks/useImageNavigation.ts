import { useCallback, useEffect, useRef } from 'react';
import { getRuntime } from '../services/runtime/runtime';
import type { ImageFile } from '../types/image';
import {
  getParentFolder,
  type FileSessionSnapshot,
  type FolderSessionSnapshot,
  readFolderIndex,
  refreshFolderIndex,
  scanFolder,
  selectFileSession,
  selectFolderSession,
} from '../services/tauriCommands';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { sortImages } from '../services/imageSorting';
import { rememberRecentFolder, type AppSettings } from '../types/settings';
import type { CurationFilter } from '../services/curationFilter';
import {
  beginFolderOpenTelemetry,
  clearPendingFolderOpenTelemetry,
  measurePerformanceSpan,
  recordFolderOpenBackgroundRefreshTelemetry,
  recordFolderOpenIndexReadTelemetry,
  recordFolderOpenReconcileTelemetry,
  recordFolderOpenSourceTelemetry,
  setNextImageSelectionKind,
} from '../services/performanceTelemetry';
import { getPersistedMarkedPathsForFolder } from '../services/markedSelectionPersistence';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { useShallow } from 'zustand/react/shallow';
import { useCurationStore } from '../state/curationStore';
import { mainWindowTitle } from '../services/windowTitle';
import { playBoundaryBeep } from '../services/boundaryFeedback';
import { useFolderWatcherLifecycle } from './useFolderWatcherLifecycle';
import { pathIdentityKey } from '../services/pathIdentity';

function normalizePathKey(path: string): string {
  return pathIdentityKey(path);
}

function rememberOpenedFolder(folderPath: string) {
  const { settings, updateSettings } = useSettingsStore.getState();
  const recentFolders = rememberRecentFolder(settings, folderPath);
  if (recentFolders === settings.recentFolders) {
    return;
  }

  void updateSettings({ recentFolders });
}

function hasImageRecordChanged(previous: ImageFile, next: ImageFile): boolean {
  return previous.size_bytes !== next.size_bytes || previous.modified_at !== next.modified_at;
}

interface FolderRefreshSnapshot {
  activeFolderPath: string;
  previousImagePath: string | null;
  previousIndex: number;
  previousImagesByPath: Map<string, ImageFile>;
}

function getFolderRefreshSnapshot(): FolderRefreshSnapshot | null {
  const state = useViewerStore.getState();
  if (!state.folderPath) {
    return null;
  }

  return {
    activeFolderPath: state.folderPath,
    previousImagePath: state.currentImagePath,
    previousIndex: state.currentIndex,
    previousImagesByPath: new Map(
      (state.allImages.length > 0 ? state.allImages : state.images).map((image) => [
        normalizePathKey(image.path),
        image,
      ])
    ),
  };
}

function collectFullRefreshInvalidatedPaths(
  previousImagesByPath: Map<string, ImageFile>,
  refreshedImages: ImageFile[]
): Set<string> {
  const refreshedImagesByPath = new Map(
    refreshedImages.map((image) => [normalizePathKey(image.path), image])
  );
  const invalidatedPaths = new Set<string>();

  for (const previousImage of previousImagesByPath.values()) {
    if (!refreshedImagesByPath.has(normalizePathKey(previousImage.path))) {
      invalidatedPaths.add(previousImage.path);
    }
  }

  for (const refreshedImage of refreshedImages) {
    const previousImage = previousImagesByPath.get(normalizePathKey(refreshedImage.path));
    if (previousImage && hasImageRecordChanged(previousImage, refreshedImage)) {
      invalidatedPaths.add(refreshedImage.path);
    }
  }

  return invalidatedPaths;
}

function invalidateFolderRefreshAssets(
  invalidatedPaths: Set<string>,
  previousImagePath: string | null
) {
  for (const path of invalidatedPaths) {
    invalidateThumbnail(path);
    invalidateImageAsset(path);
  }

  if (previousImagePath && hasMatchingPath(invalidatedPaths, previousImagePath)) {
    useViewerStore.setState({ cacheBuster: Date.now() });
  }
}

function hasMatchingPath(paths: Set<string>, targetPath: string): boolean {
  for (const path of paths) {
    if (normalizePathKey(path) === normalizePathKey(targetPath)) {
      return true;
    }
  }

  return false;
}

function getNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isSupersededFolderRefreshError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes('superseded') ||
    message.includes('stale') ||
    message.includes('cancel') ||
    message.includes('no longer active')
  );
}

async function applySnapshotCurationHydration({
  curationLoad,
  curationFilter,
  folderImagesLength,
  loadGeneration,
  isCurrentGeneration,
  prepareCurationFilter,
  emptyFolderOpenMessage,
  setError,
}: {
  curationLoad: Promise<unknown>;
  curationFilter?: CurationFilter;
  folderImagesLength: number;
  loadGeneration: number;
  isCurrentGeneration: (generation: number) => boolean;
  prepareCurationFilter: (filter: CurationFilter) => void;
  emptyFolderOpenMessage: string;
  setError: (message: string | null) => void;
}): Promise<boolean> {
  if (!curationFilter) {
    void curationLoad.catch(() => undefined);
    return true;
  }

  await curationLoad.catch(() => undefined);
  if (!isCurrentGeneration(loadGeneration)) return false;

  const curationState = useCurationStore.getState();
  prepareCurationFilter(curationFilter);
  useViewerStore
    .getState()
    .syncFavoriteFilter(curationState.curationByPath, curationState.favoritePaths);
  if (folderImagesLength === 0) {
    setError(emptyFolderOpenMessage);
  }
  return true;
}

function requestedSnapshotImage(
  session: FolderSessionSnapshot,
  requestedImageId?: string
): FolderSessionSnapshot['images'][number] | null {
  if (!requestedImageId) return null;

  const requestedImage = session.images.find((image) => image.id === requestedImageId);
  if (!requestedImage) {
    throw new Error('Native snapshot is missing the requested image');
  }
  return requestedImage;
}

function sessionSnapshotWindowTitle(
  requestedImage: FolderSessionSnapshot['images'][number] | null,
  nextFolderPath: string
): string {
  if (requestedImage) {
    return mainWindowTitle(requestedImage.file_name || 'LightFrame');
  }

  const folderName = nextFolderPath.replace(/\\/g, '/').split('/').pop() || 'LightFrame';
  return mainWindowTitle(`[Folder] ${folderName}`);
}

/** Hook for image navigation and file opening */
// fallow-ignore-next-line complexity -- navigation/session orchestration boundary
export function useImageNavigation() {
  const emptyFolderOpenMessage = 'No supported images found in the selected folder';
  const {
    images,
    allImages,
    currentIndex,
    currentImagePath,
    folderPath,
    isFolderScanning,
    setCurrentImage,
    setImages,
    setFolderPath,
    setFolderScanning,
    setCurrentIndex,
    prepareCurationFilter,
    setMarkedPaths,
    setActiveSessionId,
    navigateNext,
    navigatePrev,
    navigateFirst,
    navigateLast,
    setError,
    beginLoadGeneration,
    setViewMode,
  } = useViewerStore(
    useShallow((state) => ({
      images: state.images,
      allImages: state.allImages,
      currentIndex: state.currentIndex,
      currentImagePath: state.currentImagePath,
      folderPath: state.folderPath,
      isFolderScanning: state.isFolderScanning,
      setCurrentImage: state.setCurrentImage,
      setImages: state.setImages,
      setFolderPath: state.setFolderPath,
      setFolderScanning: state.setFolderScanning,
      setCurrentIndex: state.setCurrentIndex,
      prepareCurationFilter: state.prepareCurationFilter,
      setMarkedPaths: state.setMarkedPaths,
      setActiveSessionId: state.setActiveSessionId,
      navigateNext: state.navigateNext,
      navigatePrev: state.navigatePrev,
      navigateFirst: state.navigateFirst,
      navigateLast: state.navigateLast,
      setError: state.setError,
      beginLoadGeneration: state.beginLoadGeneration,
      setViewMode: state.setViewMode,
    }))
  );

  const { sortOrder, sortDirection, autoRefreshFolder } = useSettingsStore(
    useShallow((state) => ({
      sortOrder: state.settings.sortOrder,
      sortDirection: state.settings.sortDirection,
      autoRefreshFolder: state.settings.autoRefreshFolder,
    }))
  );
  const isMainWindowRef = useRef(getRuntime().window.label === 'main');
  const randomOrderRef = useRef<string[] | null>(null);
  const randomSortKeyRef = useRef<string | null>(null);
  const randomFolderRef = useRef<string | null>(null);
  const folderPathIndexRef = useRef<Map<string, bigint>>(new Map());
  const effectiveSortDirectionRef = useRef(sortDirection);
  const lastSortOrderRef = useRef<AppSettings['sortOrder'] | null>(null);

  const isCurrentGeneration = useCallback(
    (generation: number) => useViewerStore.getState().loadGeneration === generation,
    []
  );

  useEffect(() => {
    const sourceImages = allImages.length > 0 ? allImages : images;
    if (sourceImages.length === 0) return;

    if (randomFolderRef.current !== folderPath) {
      randomFolderRef.current = folderPath;
      randomOrderRef.current = null;
      randomSortKeyRef.current = null;
    }
    const sortKey = `${sortOrder}:${sortDirection}`;
    const effectiveSortDirection =
      lastSortOrderRef.current !== sortOrder &&
      sortOrder !== 'name' &&
      sortDirection === 'ascending'
        ? 'descending'
        : sortDirection;
    effectiveSortDirectionRef.current = effectiveSortDirection;
    lastSortOrderRef.current = sortOrder;
    if (randomSortKeyRef.current !== sortKey) {
      randomSortKeyRef.current = sortKey;
      randomOrderRef.current = null;
    }

    const sorted = sortImages(
      sourceImages,
      sortOrder,
      effectiveSortDirection,
      randomOrderRef.current
    );
    if (sortOrder === 'random' && randomOrderRef.current === null) {
      randomOrderRef.current = sorted.map((image) => image.path);
    }
    const hasOrderChanged = sorted.some((image, index) => image.path !== sourceImages[index]?.path);
    if (!hasOrderChanged) return;

    setImages(sorted);
  }, [allImages, folderPath, images, setImages, sortDirection, sortOrder]);

  useEffect(() => {
    const handleReshuffle = () => {
      if (useSettingsStore.getState().settings.sortOrder !== 'random') return;
      randomOrderRef.current = null;
      const source =
        useViewerStore.getState().allImages.length > 0
          ? useViewerStore.getState().allImages
          : useViewerStore.getState().images;
      const sorted = sortImages(source, 'random');
      randomOrderRef.current = sorted.map((image) => image.path);
      setImages(sorted);
    };
    window.addEventListener('lightframe-reshuffle-folder', handleReshuffle);
    return () => window.removeEventListener('lightframe-reshuffle-folder', handleReshuffle);
  }, [setImages]);

  const applyActiveSortOrder = useCallback((folderImages: ImageFile[], nextFolderPath?: string) => {
    if (nextFolderPath !== undefined && randomFolderRef.current !== nextFolderPath) {
      randomFolderRef.current = nextFolderPath;
      randomOrderRef.current = null;
      randomSortKeyRef.current = null;
    }

    const settings = useSettingsStore.getState().settings;
    const sortKey = `${settings.sortOrder}:${settings.sortDirection}`;
    if (randomSortKeyRef.current !== sortKey) {
      randomSortKeyRef.current = sortKey;
      randomOrderRef.current = null;
    }
    const sorted = sortImages(
      folderImages,
      settings.sortOrder,
      effectiveSortDirectionRef.current,
      randomOrderRef.current
    );
    if (settings.sortOrder === 'random') {
      randomOrderRef.current = sorted.map((image) => image.path);
    }
    return sorted;
  }, []);

  const applyFolderImages = useCallback(
    (
      folderImages: ImageFile[],
      options: {
        emptyMessage: string;
        preferredIndex: number;
        preferredPath: string | null;
        pathIndex?: Map<string, bigint>;
      }
    ) => {
      folderPathIndexRef.current =
        options.pathIndex ??
        new Map(
          folderImages.map((image, index) => [
            normalizePathKey(image.path),
            BigInt(index) * 1_000_000n,
          ])
        );
      setImages(folderImages);
      const visibleImages = useViewerStore.getState().images;

      if (visibleImages.length === 0) {
        setMarkedPaths([]);
        useViewerStore.setState({ currentImagePath: null, currentIndex: -1 });
        setError(
          useViewerStore.getState().showOnlyFavorites && folderImages.length > 0
            ? 'No favorite images found in the current folder'
            : options.emptyMessage
        );
        return;
      }

      const matchedIndex = options.preferredPath
        ? visibleImages.findIndex((image) => image.path === options.preferredPath)
        : -1;
      const nextIndex =
        matchedIndex >= 0
          ? matchedIndex
          : Math.min(Math.max(options.preferredIndex, 0), visibleImages.length - 1);
      const nextPath = visibleImages[nextIndex]?.path ?? null;
      const state = useViewerStore.getState();

      if (state.currentIndex !== nextIndex || state.currentImagePath !== nextPath) {
        setCurrentIndex(nextIndex);
      }
    },
    [setCurrentIndex, setError, setImages, setMarkedPaths]
  );

  const scanIndexedFolder = useCallback(
    async (loadGeneration: number, nextFolderPath: string) => {
      let folderImages = await measurePerformanceSpan('folderScan', () =>
        refreshFolderIndex(nextFolderPath)
      );
      if (!isCurrentGeneration(loadGeneration)) {
        return null;
      }

      folderImages = applyActiveSortOrder(folderImages, nextFolderPath);
      if (!isCurrentGeneration(loadGeneration)) {
        return null;
      }

      return folderImages;
    },
    [applyActiveSortOrder, isCurrentGeneration]
  );

  const imagesFromSessionSnapshot = useCallback((session: FolderSessionSnapshot): ImageFile[] => {
    return session.images.map((image) => ({
      id: image.id,
      sessionId: session.session_id,
      path: image.path,
      file_name: image.file_name,
      extension: image.extension,
      size_bytes: image.size_bytes,
      modified_at: image.modified_at ?? null,
      created_at: image.created_at ?? null,
    }));
  }, []);

  const readCachedFolderImages = useCallback(
    async (nextFolderPath: string) => {
      try {
        const indexReadStartedAt = getNow();
        const cachedResult = await measurePerformanceSpan('folderIndexRead', () =>
          readFolderIndex(nextFolderPath)
        );
        recordFolderOpenIndexReadTelemetry(getNow() - indexReadStartedAt);
        const folderImages = Array.isArray(cachedResult) ? cachedResult : [];
        return applyActiveSortOrder(folderImages, nextFolderPath);
      } catch (err) {
        console.warn('Failed to read folder index, falling back to live scan:', err);
        return [];
      }
    },
    [applyActiveSortOrder]
  );

  const setFolderWindowTitle = useCallback(async (nextFolderPath: string) => {
    const appWindow = getRuntime().window;
    const folderName = nextFolderPath.replace(/\\/g, '/').split('/').pop() || 'LightFrame';
    await appWindow.setTitle(mainWindowTitle(`[Folder] ${folderName}`));
  }, []);

  const applyOpenedFolderImages = useCallback(
    async (loadGeneration: number, nextFolderPath: string, folderImages: ImageFile[]) => {
      if (folderImages.length === 0) {
        applyFolderImages(folderImages, {
          emptyMessage: emptyFolderOpenMessage,
          preferredIndex: 0,
          preferredPath: null,
        });
        setFolderPath(nextFolderPath);
        clearPendingFolderOpenTelemetry(loadGeneration);
        return false;
      }

      setNextImageSelectionKind('folder-open');
      const reconcileStartedAt = getNow();
      applyFolderImages(folderImages, {
        emptyMessage: emptyFolderOpenMessage,
        preferredIndex: 0,
        preferredPath: null,
      });
      void useCurationStore
        .getState()
        .loadCuration(folderImages.map((image) => image.path))
        .catch(() => undefined);
      setMarkedPaths(
        getPersistedMarkedPathsForFolder(useSettingsStore.getState().settings, nextFolderPath)
      );
      setFolderPath(nextFolderPath);
      recordFolderOpenReconcileTelemetry(getNow() - reconcileStartedAt);

      await setFolderWindowTitle(nextFolderPath);
      if (!isCurrentGeneration(loadGeneration)) {
        clearPendingFolderOpenTelemetry(loadGeneration);
        return false;
      }

      return true;
    },
    [applyFolderImages, isCurrentGeneration, setFolderPath, setFolderWindowTitle, setMarkedPaths]
  );

  const startBackgroundFolderRefresh = useCallback(
    (loadGeneration: number, nextFolderPath: string) => {
      void (async () => {
        const backgroundRefreshStartedAt = getNow();
        try {
          const verifiedImages = await scanIndexedFolder(loadGeneration, nextFolderPath);
          if (!verifiedImages || !isCurrentGeneration(loadGeneration)) {
            if (!verifiedImages) {
              clearPendingFolderOpenTelemetry(loadGeneration);
            }
            return;
          }

          const state = useViewerStore.getState();
          applyFolderImages(verifiedImages, {
            emptyMessage: emptyFolderOpenMessage,
            preferredIndex: state.currentIndex >= 0 ? state.currentIndex : 0,
            preferredPath: state.currentImagePath,
          });
          void useCurationStore
            .getState()
            .loadCuration(verifiedImages.map((image) => image.path))
            .catch(() => undefined);
          recordFolderOpenBackgroundRefreshTelemetry(getNow() - backgroundRefreshStartedAt);
        } catch (err) {
          if (isSupersededFolderRefreshError(err)) {
            return;
          }
          console.error('Failed to refresh folder:', err);
          if (isCurrentGeneration(loadGeneration)) {
            setError(`Failed to refresh folder: ${err}`);
          }
        } finally {
          if (isCurrentGeneration(loadGeneration)) {
            setFolderScanning(false);
          }
        }
      })();
    },
    [applyFolderImages, isCurrentGeneration, scanIndexedFolder, setError, setFolderScanning]
  );

  const applySessionSnapshot = useCallback(
    async (
      session: FolderSessionSnapshot,
      options?: {
        requestedImageId?: string;
        selectionKind?: 'folder-open' | 'open-image' | 'startup-open';
        curationFilter?: CurationFilter;
        reconcileInBackground?: boolean;
      }
    ) => {
      const loadGeneration = beginLoadGeneration();
      const nextFolderPath = session.canonical_folder;
      const requestedImage = requestedSnapshotImage(session, options?.requestedImageId);
      let backgroundRefreshStarted = false;

      try {
        setFolderScanning(false);
        setViewMode('viewer');
        setActiveSessionId(session.session_id);
        setNextImageSelectionKind(options?.selectionKind ?? 'folder-open');

        const folderImages = applyActiveSortOrder(
          imagesFromSessionSnapshot(session),
          nextFolderPath
        );
        if (!isCurrentGeneration(loadGeneration)) return;

        applyFolderImages(folderImages, {
          emptyMessage: emptyFolderOpenMessage,
          preferredIndex: 0,
          preferredPath: requestedImage?.path ?? null,
        });
        setMarkedPaths(
          getPersistedMarkedPathsForFolder(useSettingsStore.getState().settings, nextFolderPath)
        );
        setFolderPath(nextFolderPath);
        const curationLoad = useCurationStore
          .getState()
          .loadCuration(folderImages.map((image) => image.path));
        const curationHydrated = await applySnapshotCurationHydration({
          curationLoad,
          curationFilter: options?.curationFilter,
          folderImagesLength: folderImages.length,
          loadGeneration,
          isCurrentGeneration,
          prepareCurationFilter,
          emptyFolderOpenMessage,
          setError,
        });
        if (!curationHydrated) return;

        await getRuntime().window.setTitle(
          sessionSnapshotWindowTitle(requestedImage, nextFolderPath)
        );
        rememberOpenedFolder(nextFolderPath);
        if (options?.reconcileInBackground) {
          backgroundRefreshStarted = true;
          setFolderScanning(true);
          startBackgroundFolderRefresh(loadGeneration, nextFolderPath);
        }
      } catch (err) {
        if (isCurrentGeneration(loadGeneration)) {
          setError(`Failed to apply native session: ${err}`);
        }
        throw err;
      } finally {
        if (!backgroundRefreshStarted && isCurrentGeneration(loadGeneration)) {
          setFolderScanning(false);
        }
      }
    },
    [
      applyActiveSortOrder,
      applyFolderImages,
      beginLoadGeneration,
      emptyFolderOpenMessage,
      imagesFromSessionSnapshot,
      isCurrentGeneration,
      prepareCurationFilter,
      setActiveSessionId,
      setError,
      setFolderPath,
      setFolderScanning,
      setMarkedPaths,
      startBackgroundFolderRefresh,
      setViewMode,
    ]
  );

  const applyFolderSessionSnapshot = useCallback(
    async (session: FolderSessionSnapshot, options?: { curationFilter?: CurationFilter }) => {
      await applySessionSnapshot(session, {
        selectionKind: 'folder-open',
        curationFilter: options?.curationFilter,
        reconcileInBackground: true,
      });
    },
    [applySessionSnapshot]
  );

  const applyFileSessionSnapshot = useCallback(
    async (session: FileSessionSnapshot, options?: { startup?: boolean }) => {
      await applySessionSnapshot(session, {
        requestedImageId: session.requested_image_id,
        selectionKind: options?.startup ? 'startup-open' : 'open-image',
        reconcileInBackground: true,
      });
    },
    [applySessionSnapshot]
  );

  const scanFolderForImage = useCallback(
    async (loadGeneration: number, filePath: string, parentFolder: string) => {
      try {
        let folderImages = await measurePerformanceSpan('folderScan', () =>
          scanFolder(parentFolder)
        );
        if (!isCurrentGeneration(loadGeneration)) return;

        folderImages = applyActiveSortOrder(folderImages, parentFolder);
        if (!isCurrentGeneration(loadGeneration)) return;

        const normalizedPath = pathIdentityKey(filePath);
        const index = folderImages.findIndex(
          (image) => pathIdentityKey(image.path) === normalizedPath
        );
        applyFolderImages(folderImages, {
          emptyMessage: emptyFolderOpenMessage,
          preferredIndex: index >= 0 ? index : 0,
          preferredPath: filePath,
        });
        setMarkedPaths(
          getPersistedMarkedPathsForFolder(useSettingsStore.getState().settings, parentFolder)
        );
        setFolderPath(parentFolder);
      } catch (err) {
        console.error('Failed to scan folder:', err);
        if (isCurrentGeneration(loadGeneration)) {
          setError(`Failed to scan folder: ${err}`);
        }
      } finally {
        if (isCurrentGeneration(loadGeneration)) {
          setFolderScanning(false);
        }
      }
    },
    [
      isCurrentGeneration,
      setError,
      setFolderScanning,
      applyActiveSortOrder,
      applyFolderImages,
      emptyFolderOpenMessage,
      setFolderPath,
      setMarkedPaths,
    ]
  );

  const loadImageFile = useCallback(
    async (filePath: string, scanInBackground = false) => {
      const loadGeneration = beginLoadGeneration();

      try {
        const parentFolder = getParentFolder(filePath);
        setNextImageSelectionKind(scanInBackground ? 'startup-open' : 'open-image');
        setCurrentImage(filePath, 0);
        setViewMode('viewer');

        const appWindow = getRuntime().window;
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'LightFrame';
        await appWindow.setTitle(mainWindowTitle(fileName));
        if (!isCurrentGeneration(loadGeneration)) return;

        setFolderScanning(true);
        const scanPromise = scanFolderForImage(loadGeneration, filePath, parentFolder);
        if (scanInBackground) {
          void scanPromise;
        } else {
          await scanPromise;
        }
      } catch (err) {
        if (isCurrentGeneration(loadGeneration)) {
          setError(`Could not open image: ${err}`);
        }
      }
    },
    [
      beginLoadGeneration,
      isCurrentGeneration,
      scanFolderForImage,
      setCurrentImage,
      setError,
      setFolderScanning,
      setViewMode,
    ]
  );

  /** Open and display a specific image file */
  const openImage = useCallback(
    async (filePath: string) => {
      await loadImageFile(filePath);
    },
    [loadImageFile]
  );

  /** Open an image for startup and continue folder scan in the background */
  const openImageForStartup = useCallback(
    async (filePath: string) => {
      await loadImageFile(filePath, true);
    },
    [loadImageFile]
  );

  /** Open a file picker dialog */
  const openFilePicker = useCallback(async () => {
    try {
      const selected = await selectFileSession();
      if (selected) {
        await applyFileSessionSnapshot(selected);
      }
    } catch (err) {
      console.error('File picker error:', err);
    }
  }, [applyFileSessionSnapshot]);

  /** Open a specific folder */
  const openFolder = useCallback(
    async (nextFolderPath: string, options?: { curationFilter?: CurationFilter }) => {
      const loadGeneration = beginLoadGeneration();
      let backgroundRefreshStarted = false;

      try {
        setFolderScanning(true);
        setViewMode('viewer');
        await setFolderWindowTitle(nextFolderPath);
        if (options?.curationFilter) {
          prepareCurationFilter(options.curationFilter);
        }

        beginFolderOpenTelemetry(loadGeneration);
        const cachedImages = await readCachedFolderImages(nextFolderPath);

        if (!isCurrentGeneration(loadGeneration)) {
          clearPendingFolderOpenTelemetry(loadGeneration);
          return;
        }

        if (cachedImages.length > 0) {
          recordFolderOpenSourceTelemetry('cache');
          const appliedCachedImages = await applyOpenedFolderImages(
            loadGeneration,
            nextFolderPath,
            cachedImages
          );
          if (!appliedCachedImages) {
            return;
          }

          rememberOpenedFolder(nextFolderPath);
          backgroundRefreshStarted = true;
          startBackgroundFolderRefresh(loadGeneration, nextFolderPath);
          return;
        }

        recordFolderOpenSourceTelemetry('scan');
        const folderImages = await scanIndexedFolder(loadGeneration, nextFolderPath);
        if (!folderImages || !isCurrentGeneration(loadGeneration)) {
          clearPendingFolderOpenTelemetry(loadGeneration);
          return;
        }

        const appliedFolderImages = await applyOpenedFolderImages(
          loadGeneration,
          nextFolderPath,
          folderImages
        );
        if (appliedFolderImages) {
          rememberOpenedFolder(nextFolderPath);
        }
      } catch (err) {
        console.error('Failed to open folder:', err);
        clearPendingFolderOpenTelemetry(loadGeneration);
        if (isCurrentGeneration(loadGeneration)) {
          setError(`Failed to open folder: ${err}`);
        }
      } finally {
        if (!backgroundRefreshStarted && isCurrentGeneration(loadGeneration)) {
          setFolderScanning(false);
        }
      }
    },
    [
      beginLoadGeneration,
      isCurrentGeneration,
      setError,
      setFolderScanning,
      setViewMode,
      prepareCurationFilter,
      applyOpenedFolderImages,
      readCachedFolderImages,
      scanIndexedFolder,
      startBackgroundFolderRefresh,
      setFolderWindowTitle,
    ]
  );

  /** Open a folder picker dialog */
  const openFolderPicker = useCallback(async () => {
    try {
      const selected = await selectFolderSession();
      if (selected) {
        await applyFolderSessionSnapshot(selected);
      }
    } catch (err) {
      console.error('Folder picker error:', err);
    }
  }, [applyFolderSessionSnapshot]);

  const refreshFolderFromDisk = useCallback(async () => {
    const snapshot = getFolderRefreshSnapshot();
    if (!snapshot) {
      setError('No folder is currently open to refresh');
      return;
    }

    const loadGeneration = beginLoadGeneration();

    try {
      setFolderScanning(true);

      let refreshedImages = await measurePerformanceSpan('folderScan', () =>
        refreshFolderIndex(snapshot.activeFolderPath)
      );
      if (!isCurrentGeneration(loadGeneration)) return;

      refreshedImages = applyActiveSortOrder(refreshedImages, snapshot.activeFolderPath);
      if (!isCurrentGeneration(loadGeneration)) return;

      const invalidatedPaths = collectFullRefreshInvalidatedPaths(
        snapshot.previousImagesByPath,
        refreshedImages
      );
      invalidateFolderRefreshAssets(invalidatedPaths, snapshot.previousImagePath);

      applyFolderImages(refreshedImages, {
        emptyMessage: 'No supported images found in the current folder',
        preferredIndex: snapshot.previousIndex,
        preferredPath: snapshot.previousImagePath,
      });
    } catch (err) {
      console.error('Failed to refresh folder:', err);
      if (isCurrentGeneration(loadGeneration)) {
        setError(`Failed to refresh folder: ${err}`);
      }
    } finally {
      if (isCurrentGeneration(loadGeneration)) {
        setFolderScanning(false);
      }
    }
  }, [
    beginLoadGeneration,
    isCurrentGeneration,
    setError,
    setFolderScanning,
    applyActiveSortOrder,
    applyFolderImages,
  ]);

  /** Rescan current folder and preserve selection when possible */
  const refreshFolder = useCallback(async () => {
    await refreshFolderFromDisk();
  }, [refreshFolderFromDisk]);

  useFolderWatcherLifecycle({
    isMainWindow: isMainWindowRef.current,
    folderPath,
    autoRefreshFolder,
    isFolderScanning,
    randomOrderRef,
    folderPathIndexRef,
    applyFolderImages,
    refreshFolderFromDisk,
  });

  /** Navigate to the next image */
  const goNext = useCallback(
    (loop?: boolean) => {
      const success = navigateNext(loop);
      if (!success && images.length > 1) {
        void playBoundaryBeep();
      }
      return success;
    },
    [images.length, navigateNext]
  );

  /** Navigate to the previous image */
  const goPrev = useCallback(
    (loop?: boolean) => {
      const success = navigatePrev(loop);
      if (!success && images.length > 1) {
        void playBoundaryBeep();
      }
      return success;
    },
    [images.length, navigatePrev]
  );

  return {
    images,
    currentIndex,
    currentImagePath,
    folderPath,
    isFolderScanning,
    openImage,
    openImageForStartup,
    applyFolderSessionSnapshot,
    applyFileSessionSnapshot,
    openFolder,
    openFilePicker,
    openFolderPicker,
    refreshFolder,
    goNext,
    goPrev,
    goFirst: navigateFirst,
    goLast: navigateLast,
  };
}

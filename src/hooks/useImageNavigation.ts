import { useCallback, useEffect, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ImageFile } from '../types/image';
import {
  getParentFolder,
  listenToFolderWatcherChanges,
  readFolderIndex,
  refreshFolderIndex,
  scanFolder,
  unwatchFolder,
  watchFolder,
  type FolderWatcherPayload,
} from '../services/tauriCommands';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { sortImages } from '../services/imageSorting';
import { reconcileFolderWatcherPayload } from '../services/folderWatcherReconciliation';
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
import { mainWindowTitle } from '../services/windowTitle';

/** Play a subtle 'boop' sound when hitting the edge of a folder */
function playBoundaryBeep() {
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof window.AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const ctx = new AudioContextCtor();
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.15);

    gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // Ignore audio errors
  }
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
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

/** Hook for image navigation and file opening */
export function useImageNavigation() {
  const emptyFolderOpenMessage = 'No supported images found in the selected folder';
  const images = useViewerStore((state) => state.images);
  const allImages = useViewerStore((state) => state.allImages);
  const currentIndex = useViewerStore((state) => state.currentIndex);
  const currentImagePath = useViewerStore((state) => state.currentImagePath);
  const folderPath = useViewerStore((state) => state.folderPath);
  const isFolderScanning = useViewerStore((state) => state.isFolderScanning);
  const setCurrentImage = useViewerStore((state) => state.setCurrentImage);
  const setImages = useViewerStore((state) => state.setImages);
  const setFolderPath = useViewerStore((state) => state.setFolderPath);
  const setFolderScanning = useViewerStore((state) => state.setFolderScanning);
  const setCurrentIndex = useViewerStore((state) => state.setCurrentIndex);
  const prepareCurationFilter = useViewerStore((state) => state.prepareCurationFilter);
  const setMarkedPaths = useViewerStore((state) => state.setMarkedPaths);
  const navigateNext = useViewerStore((state) => state.navigateNext);
  const navigatePrev = useViewerStore((state) => state.navigatePrev);
  const navigateFirst = useViewerStore((state) => state.navigateFirst);
  const navigateLast = useViewerStore((state) => state.navigateLast);
  const setError = useViewerStore((state) => state.setError);
  const beginLoadGeneration = useViewerStore((state) => state.beginLoadGeneration);
  const setViewMode = useViewerStore((state) => state.setViewMode);

  const sortOrder = useSettingsStore((state) => state.settings.sortOrder);
  const sortDirection = useSettingsStore((state) => state.settings.sortDirection);
  const autoRefreshFolder = useSettingsStore((state) => state.settings.autoRefreshFolder);
  const isMainWindowRef = useRef(getCurrentWindow().label === 'main');
  const pendingWatcherRefreshFolderRef = useRef<string | null>(null);
  const randomOrderRef = useRef<string[] | null>(null);
  const randomSortKeyRef = useRef<string | null>(null);
  const randomFolderRef = useRef<string | null>(null);
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
      }
    ) => {
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
    const appWindow = getCurrentWindow();
    const folderName = nextFolderPath.replace(/\\/g, '/').split('/').pop() || 'LightFrame';
    await appWindow.setTitle(mainWindowTitle(`[Folder] ${folderName}`));
  }, []);

  const applyOpenedFolderImages = useCallback(
    async (loadGeneration: number, nextFolderPath: string, folderImages: ImageFile[]) => {
      if (folderImages.length === 0) {
        setMarkedPaths([]);
        setFolderPath(nextFolderPath);
        clearPendingFolderOpenTelemetry(loadGeneration);
        setError(emptyFolderOpenMessage);
        return false;
      }

      setNextImageSelectionKind('folder-open');
      const reconcileStartedAt = getNow();
      applyFolderImages(folderImages, {
        emptyMessage: emptyFolderOpenMessage,
        preferredIndex: 0,
        preferredPath: null,
      });
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
    [
      applyFolderImages,
      isCurrentGeneration,
      setError,
      setFolderPath,
      setFolderWindowTitle,
      setMarkedPaths,
    ]
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
          recordFolderOpenBackgroundRefreshTelemetry(getNow() - backgroundRefreshStartedAt);
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
      })();
    },
    [applyFolderImages, isCurrentGeneration, scanIndexedFolder, setError, setFolderScanning]
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

        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        const index = folderImages.findIndex(
          (image) => image.path.replace(/\\/g, '/').toLowerCase() === normalizedPath
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

        const appWindow = getCurrentWindow();
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
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Images',
            extensions: [
              'jpg',
              'jpeg',
              'png',
              'webp',
              'gif',
              'bmp',
              'tiff',
              'tif',
              'heic',
              'heif',
              'avif',
              'svg',
            ],
          },
        ],
      });

      if (selected) {
        await openImage(selected as string);
      }
    } catch (err) {
      console.error('File picker error:', err);
    }
  }, [openImage]);

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
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected) {
        await openFolder(selected as string);
      }
    } catch (err) {
      console.error('Folder picker error:', err);
    }
  }, [openFolder]);

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

  const handleFolderWatcherPayload = useCallback(
    (payload: FolderWatcherPayload) => {
      const state = useViewerStore.getState();
      if (
        !state.folderPath ||
        normalizePathKey(state.folderPath) !== normalizePathKey(payload.folderPath)
      ) {
        return;
      }

      if (state.isFolderScanning) {
        pendingWatcherRefreshFolderRef.current = state.folderPath;
        return;
      }

      const reconciliation = reconcileFolderWatcherPayload({
        payload,
        images: state.allImages.length > 0 ? state.allImages : state.images,
        currentIndex: state.currentIndex,
        currentImagePath: state.currentImagePath,
        sortOrder: useSettingsStore.getState().settings.sortOrder,
        sortDirection: useSettingsStore.getState().settings.sortDirection,
        randomOrder: randomOrderRef.current,
      });

      if (reconciliation.requiresFullRefresh) {
        void refreshFolderFromDisk();
        return;
      }

      if (useSettingsStore.getState().settings.sortOrder === 'random') {
        randomOrderRef.current = reconciliation.images.map((image) => image.path);
      }

      for (const path of reconciliation.invalidatedPaths) {
        invalidateThumbnail(path);
        invalidateImageAsset(path);
      }

      if (
        state.currentImagePath &&
        reconciliation.invalidatedPaths.some(
          (path) => normalizePathKey(path) === normalizePathKey(state.currentImagePath ?? '')
        )
      ) {
        useViewerStore.setState({ cacheBuster: Date.now() });
      }

      applyFolderImages(reconciliation.images, {
        emptyMessage: 'No supported images found in the current folder',
        preferredIndex: reconciliation.preferredIndex,
        preferredPath: reconciliation.preferredPath,
      });
    },
    [applyFolderImages, refreshFolderFromDisk]
  );

  const handleFolderWatcherPayloadRef = useRef(handleFolderWatcherPayload);
  useEffect(() => {
    handleFolderWatcherPayloadRef.current = handleFolderWatcherPayload;
  }, [handleFolderWatcherPayload]);

  useEffect(() => {
    if (isFolderScanning) {
      return;
    }

    const dirtyFolderPath = pendingWatcherRefreshFolderRef.current;
    if (!dirtyFolderPath) {
      return;
    }

    pendingWatcherRefreshFolderRef.current = null;
    if (!folderPath || normalizePathKey(folderPath) !== normalizePathKey(dirtyFolderPath)) {
      return;
    }

    void refreshFolderFromDisk();
  }, [folderPath, isFolderScanning, refreshFolderFromDisk]);

  useEffect(() => {
    if (!isMainWindowRef.current || !folderPath || !autoRefreshFolder) {
      return;
    }

    const watchId = `folder-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        unlisten = await listenToFolderWatcherChanges((payload) =>
          handleFolderWatcherPayloadRef.current(payload)
        );
        if (disposed) {
          unlisten();
          return;
        }

        await watchFolder(folderPath, watchId);
        if (disposed) {
          await unwatchFolder(watchId);
        }
      } catch (err) {
        console.warn('Failed to start folder watcher:', err);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      void unwatchFolder(watchId).catch((err) => {
        console.warn('Failed to stop folder watcher:', err);
      });
    };
  }, [autoRefreshFolder, folderPath]);

  /** Navigate to the next image */
  const goNext = useCallback(
    (loop?: boolean) => {
      const success = navigateNext(loop);
      if (!success && images.length > 1) {
        playBoundaryBeep();
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
        playBoundaryBeep();
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

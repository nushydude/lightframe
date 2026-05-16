import { useCallback, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ImageFile } from '../types/image';
import {
  getParentFolder,
  readFolderIndex,
  refreshFolderIndex,
  scanFolder,
} from '../services/tauriCommands';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { sortImages } from '../services/imageSorting';
import {
  beginFolderOpenTelemetry,
  clearPendingFolderOpenTelemetry,
  measurePerformanceSpan,
  setNextImageSelectionKind,
} from '../services/performanceTelemetry';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';

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

/** Hook for image navigation and file opening */
export function useImageNavigation() {
  const emptyFolderOpenMessage = 'No supported images found in the selected folder';
  const {
    images,
    currentIndex,
    currentImagePath,
    folderPath,
    isFolderScanning,
    setCurrentImage,
    setImages,
    setFolderPath,
    setFolderScanning,
    setCurrentIndex,
    navigateNext,
    navigatePrev,
    navigateFirst,
    navigateLast,
    setError,
    beginLoadGeneration,
    setViewMode,
  } = useViewerStore();

  const settings = useSettingsStore((state) => state.settings);

  const isCurrentGeneration = useCallback(
    (generation: number) => useViewerStore.getState().loadGeneration === generation,
    []
  );

  useEffect(() => {
    if (images.length === 0 || settings.sortOrder === 'name') return;

    const sorted = sortImages([...images], settings.sortOrder);
    const hasOrderChanged = sorted.some((image, index) => image.path !== images[index]?.path);
    if (!hasOrderChanged) return;

    const currentPath = images[currentIndex]?.path;
    setImages(sorted);

    if (currentPath) {
      const newIndex = sorted.findIndex((image) => image.path === currentPath);
      if (newIndex >= 0 && newIndex !== currentIndex) {
        setCurrentIndex(newIndex);
      }
    }
  }, [currentIndex, images, setCurrentIndex, setImages, settings.sortOrder]);

  const applyActiveSortOrder = useCallback(
    (folderImages: ImageFile[]) =>
      settings.sortOrder === 'name' ? folderImages : sortImages(folderImages, settings.sortOrder),
    [settings.sortOrder]
  );

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

      if (folderImages.length === 0) {
        useViewerStore.setState({ currentImagePath: null, currentIndex: -1 });
        setError(options.emptyMessage);
        return;
      }

      const matchedIndex = options.preferredPath
        ? folderImages.findIndex((image) => image.path === options.preferredPath)
        : -1;
      const nextIndex =
        matchedIndex >= 0
          ? matchedIndex
          : Math.min(Math.max(options.preferredIndex, 0), folderImages.length - 1);
      const nextPath = folderImages[nextIndex]?.path ?? null;
      const state = useViewerStore.getState();

      if (state.currentIndex !== nextIndex || state.currentImagePath !== nextPath) {
        setCurrentIndex(nextIndex);
      }
    },
    [setCurrentIndex, setError, setImages]
  );

  const scanIndexedFolder = useCallback(
    async (loadGeneration: number, nextFolderPath: string) => {
      let folderImages = await measurePerformanceSpan('folderScan', () =>
        refreshFolderIndex(nextFolderPath)
      );
      if (!isCurrentGeneration(loadGeneration)) {
        return null;
      }

      folderImages = applyActiveSortOrder(folderImages);
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
        const cachedResult = await readFolderIndex(nextFolderPath);
        const folderImages = Array.isArray(cachedResult) ? cachedResult : [];
        return applyActiveSortOrder(folderImages);
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
    await appWindow.setTitle(`[Folder] ${folderName} - LightFrame`);
  }, []);

  const applyOpenedFolderImages = useCallback(
    async (loadGeneration: number, nextFolderPath: string, folderImages: ImageFile[]) => {
      if (folderImages.length === 0) {
        clearPendingFolderOpenTelemetry(loadGeneration);
        setError(emptyFolderOpenMessage);
        return false;
      }

      setNextImageSelectionKind('folder-open');
      applyFolderImages(folderImages, {
        emptyMessage: emptyFolderOpenMessage,
        preferredIndex: 0,
        preferredPath: null,
      });

      await setFolderWindowTitle(nextFolderPath);
      if (!isCurrentGeneration(loadGeneration)) {
        clearPendingFolderOpenTelemetry(loadGeneration);
        return false;
      }

      return true;
    },
    [applyFolderImages, isCurrentGeneration, setError, setFolderWindowTitle]
  );

  const startBackgroundFolderRefresh = useCallback(
    (loadGeneration: number, nextFolderPath: string) => {
      void (async () => {
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

        folderImages = applyActiveSortOrder(folderImages);
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
    ]
  );

  const loadImageFile = useCallback(
    async (filePath: string, scanInBackground = false) => {
      const loadGeneration = beginLoadGeneration();

      try {
        const parentFolder = getParentFolder(filePath);
        setFolderPath(parentFolder);
        setNextImageSelectionKind(scanInBackground ? 'startup-open' : 'open-image');
        setCurrentImage(filePath, 0);
        setViewMode('viewer');

        const appWindow = getCurrentWindow();
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'LightFrame';
        await appWindow.setTitle(`${fileName} - LightFrame`);
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
      setFolderPath,
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
    async (nextFolderPath: string) => {
      const loadGeneration = beginLoadGeneration();
      let backgroundRefreshStarted = false;

      try {
        setFolderPath(nextFolderPath);
        setFolderScanning(true);
        setViewMode('viewer');

        beginFolderOpenTelemetry(loadGeneration);
        const cachedImages = await readCachedFolderImages(nextFolderPath);

        if (!isCurrentGeneration(loadGeneration)) {
          clearPendingFolderOpenTelemetry(loadGeneration);
          return;
        }

        if (cachedImages.length > 0) {
          const appliedCachedImages = await applyOpenedFolderImages(
            loadGeneration,
            nextFolderPath,
            cachedImages
          );
          if (!appliedCachedImages) {
            return;
          }

          backgroundRefreshStarted = true;
          startBackgroundFolderRefresh(loadGeneration, nextFolderPath);
          return;
        }

        const folderImages = await scanIndexedFolder(loadGeneration, nextFolderPath);
        if (!folderImages || !isCurrentGeneration(loadGeneration)) {
          clearPendingFolderOpenTelemetry(loadGeneration);
          return;
        }

        await applyOpenedFolderImages(loadGeneration, nextFolderPath, folderImages);
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
      setFolderPath,
      setFolderScanning,
      setViewMode,
      applyOpenedFolderImages,
      readCachedFolderImages,
      scanIndexedFolder,
      startBackgroundFolderRefresh,
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

  /** Rescan current folder and preserve selection when possible */
  const refreshFolder = useCallback(async () => {
    if (!folderPath) {
      setError('No folder is currently open to refresh');
      return;
    }

    const previousImagePath = currentImagePath;
    const previousIndex = currentIndex;
    const previousPaths = new Set(images.map((image) => image.path));
    const loadGeneration = beginLoadGeneration();

    try {
      setFolderScanning(true);

      let refreshedImages = await measurePerformanceSpan('folderScan', () =>
        refreshFolderIndex(folderPath)
      );
      if (!isCurrentGeneration(loadGeneration)) return;

      refreshedImages = applyActiveSortOrder(refreshedImages);
      if (!isCurrentGeneration(loadGeneration)) return;

      const refreshedPaths = new Set(refreshedImages.map((image) => image.path));
      for (const existingPath of previousPaths) {
        if (!refreshedPaths.has(existingPath)) {
          invalidateThumbnail(existingPath);
          invalidateImageAsset(existingPath);
        }
      }

      applyFolderImages(refreshedImages, {
        emptyMessage: 'No supported images found in the current folder',
        preferredIndex: previousIndex,
        preferredPath: previousImagePath,
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
    currentImagePath,
    currentIndex,
    folderPath,
    images,
    isCurrentGeneration,
    setError,
    setFolderScanning,
    applyActiveSortOrder,
    applyFolderImages,
  ]);

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

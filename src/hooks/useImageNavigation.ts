import { useCallback, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { scanFolder, getParentFolder } from '../services/tauriCommands';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { sortImages } from '../services/imageSorting';
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

  const scanFolderForImage = useCallback(
    async (loadGeneration: number, filePath: string, parentFolder: string) => {
      try {
        let folderImages = await scanFolder(parentFolder);
        if (!isCurrentGeneration(loadGeneration)) return;

        if (settings.sortOrder !== 'name') {
          folderImages = sortImages(folderImages, settings.sortOrder);
        }
        if (!isCurrentGeneration(loadGeneration)) return;

        setImages(folderImages);

        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        const index = folderImages.findIndex(
          (image) => image.path.replace(/\\/g, '/').toLowerCase() === normalizedPath
        );

        if (index >= 0 && isCurrentGeneration(loadGeneration)) {
          setCurrentIndex(index);
        }
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
      setCurrentIndex,
      setError,
      setFolderScanning,
      setImages,
      settings.sortOrder,
    ]
  );

  const loadImageFile = useCallback(
    async (filePath: string, scanInBackground = false) => {
      const loadGeneration = beginLoadGeneration();

      try {
        const parentFolder = getParentFolder(filePath);
        setFolderPath(parentFolder);
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

      try {
        setFolderPath(nextFolderPath);
        setFolderScanning(true);
        setViewMode('viewer');

        let folderImages = await scanFolder(nextFolderPath);
        if (!isCurrentGeneration(loadGeneration)) return;

        if (settings.sortOrder !== 'name') {
          folderImages = sortImages(folderImages, settings.sortOrder);
        }
        if (!isCurrentGeneration(loadGeneration)) return;

        setImages(folderImages);

        if (folderImages.length > 0) {
          setCurrentIndex(0);

          const appWindow = getCurrentWindow();
          const folderName = nextFolderPath.replace(/\\/g, '/').split('/').pop() || 'LightFrame';
          await appWindow.setTitle(`[Folder] ${folderName} - LightFrame`);
          if (!isCurrentGeneration(loadGeneration)) return;
        } else if (isCurrentGeneration(loadGeneration)) {
          setError('No supported images found in the selected folder');
        }
      } catch (err) {
        console.error('Failed to open folder:', err);
        if (isCurrentGeneration(loadGeneration)) {
          setError(`Failed to open folder: ${err}`);
        }
      } finally {
        if (isCurrentGeneration(loadGeneration)) {
          setFolderScanning(false);
        }
      }
    },
    [
      beginLoadGeneration,
      isCurrentGeneration,
      setCurrentIndex,
      setError,
      setFolderPath,
      setFolderScanning,
      setViewMode,
      setImages,
      settings.sortOrder,
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

      let refreshedImages = await scanFolder(folderPath);
      if (!isCurrentGeneration(loadGeneration)) return;

      if (settings.sortOrder !== 'name') {
        refreshedImages = sortImages(refreshedImages, settings.sortOrder);
      }
      if (!isCurrentGeneration(loadGeneration)) return;

      setImages(refreshedImages);

      const refreshedPaths = new Set(refreshedImages.map((image) => image.path));
      for (const existingPath of previousPaths) {
        if (!refreshedPaths.has(existingPath)) {
          invalidateThumbnail(existingPath);
          invalidateImageAsset(existingPath);
        }
      }

      if (refreshedImages.length === 0) {
        useViewerStore.setState({ currentImagePath: null, currentIndex: -1 });
        setError('No supported images found in the current folder');
        return;
      }

      if (previousImagePath) {
        const previousPathIndex = refreshedImages.findIndex(
          (image) => image.path === previousImagePath
        );
        if (previousPathIndex >= 0) {
          setCurrentIndex(previousPathIndex);
          return;
        }
      }

      const nearestIndex = Math.min(Math.max(previousIndex, 0), refreshedImages.length - 1);
      setCurrentIndex(nearestIndex);
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
    setCurrentIndex,
    setError,
    setFolderScanning,
    setImages,
    settings.sortOrder,
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

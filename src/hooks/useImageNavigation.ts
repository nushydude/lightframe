import { useCallback, useEffect } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { scanFolder, getParentFolder } from '../services/tauriCommands';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ImageFile } from '../types/image';
import { useSettingsStore } from '../state/settingsStore';

/** Play a subtle 'boop' sound when hitting the edge of a folder */
function playBoundaryBeep() {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
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
  } catch (e) {
    // Ignore audio errors
  }
}

function sortImages(images: ImageFile[], sortOrder: string): ImageFile[] {
  const sorted = [...images];
  switch (sortOrder) {
    case 'date':
      sorted.sort((a, b) => {
        const da = a.modified_at ? parseInt(a.modified_at, 10) : 0;
        const db = b.modified_at ? parseInt(b.modified_at, 10) : 0;
        return db - da; // Newest first
      });
      break;
    case 'size':
      sorted.sort((a, b) => b.size_bytes - a.size_bytes); // Largest first
      break;
    case 'random':
      sorted.sort(() => Math.random() - 0.5);
      break;
    case 'name':
    default:
      // By default they are naturally sorted from Rust
      break;
  }
  return sorted;
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
  } = useViewerStore();

  const settings = useSettingsStore((s) => s.settings);

  useEffect(() => {
    if (images.length === 0 || settings.sortOrder === 'name') return;
    const sorted = sortImages([...images], settings.sortOrder);
    const currentPath = images[currentIndex]?.path;
    setImages(sorted);
    if (currentPath) {
      const newIndex = sorted.findIndex(img => img.path === currentPath);
      if (newIndex >= 0 && newIndex !== currentIndex) {
        setCurrentIndex(newIndex);
      }
    }
  }, [settings.sortOrder]);

  /** Open and display a specific image file */
  const openImage = useCallback(
    async (filePath: string) => {
      try {
        // Immediately show the image
        const parentFolder = getParentFolder(filePath);
        setFolderPath(parentFolder);
        setCurrentImage(filePath, 0);

        // Update window title
        const appWindow = getCurrentWindow();
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'LightFrame';
        await appWindow.setTitle(`${fileName} — LightFrame`);

        // Scan folder in background
        setFolderScanning(true);
        try {
          let folderImages = await scanFolder(parentFolder);
          
          if (settings.sortOrder !== 'name') {
            folderImages = sortImages(folderImages, settings.sortOrder);
          }
          
          setImages(folderImages);

          // Find the current image in the list
          const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
          const idx = folderImages.findIndex(
            (img) => img.path.replace(/\\/g, '/').toLowerCase() === normalizedPath
          );
          if (idx >= 0) {
            setCurrentIndex(idx);
          }
        } catch (err) {
          console.error('Failed to scan folder:', err);
        } finally {
          setFolderScanning(false);
        }
      } catch (err) {
        setError(`Could not open image: ${err}`);
      }
    },
    [setCurrentImage, setImages, setFolderPath, setFolderScanning, setCurrentIndex, setError]
  );

  /** Open a file picker dialog */
  const openFilePicker = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Images',
            extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif', 'svg'],
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
  const openFolder = useCallback(async (folderPath: string) => {
    try {
      setFolderPath(folderPath);
      setFolderScanning(true);
      let folderImages = await scanFolder(folderPath);
      if (settings.sortOrder !== 'name') {
        folderImages = sortImages(folderImages, settings.sortOrder);
      }
      setImages(folderImages);
      if (folderImages.length > 0) {
        setCurrentIndex(0);
        const appWindow = getCurrentWindow();
        const folderName = folderPath.replace(/\\/g, '/').split('/').pop() || 'LightFrame';
        await appWindow.setTitle(`[Folder] ${folderName} — LightFrame`);
      } else {
        setError('No supported images found in the selected folder');
      }
    } catch (err) {
      console.error('Failed to open folder:', err);
      setError(`Failed to open folder: ${err}`);
    } finally {
      setFolderScanning(false);
    }
  }, [setImages, setFolderPath, setFolderScanning, setCurrentIndex, setError, settings.sortOrder]);

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

  /** Navigate to the next image */
  const goNext = useCallback(
    (loop?: boolean) => {
      const success = navigateNext(loop);
      if (!success && images.length > 1) {
        playBoundaryBeep();
      }
      return success;
    },
    [navigateNext, images.length]
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
    [navigatePrev, images.length]
  );

  return {
    images,
    currentIndex,
    currentImagePath,
    folderPath,
    isFolderScanning,
    openImage,
    openFolder,
    openFilePicker,
    openFolderPicker,
    goNext,
    goPrev,
    goFirst: navigateFirst,
    goLast: navigateLast,
  };
}

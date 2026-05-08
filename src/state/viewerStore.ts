import { create } from 'zustand';
import type { ImageFile } from '../types/image';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';

export type ZoomMode = 'fit' | 'fill' | 'actual' | 'custom';

interface ViewerState {
  // Image state
  currentImagePath: string | null;
  folderPath: string | null;
  images: ImageFile[];
  currentIndex: number;
  isFolderScanning: boolean;
  cacheBuster: number;
  loadGeneration: number;

  // Display state
  isFullscreen: boolean;
  defaultZoomMode: ZoomMode;
  zoomMode: ZoomMode;
  zoomLevel: number;
  panX: number;
  panY: number;
  rotation: number; // In degrees

  // Slideshow state
  isSlideshowActive: boolean;
  isSlideshowPaused: boolean;

  // UI state
  showControls: boolean;
  showSettings: boolean;
  errorMessage: string | null;
  viewMode: 'viewer' | 'grid';

  // Actions
  setCurrentImage: (path: string, index: number) => void;
  setImages: (images: ImageFile[]) => void;
  setFolderPath: (path: string) => void;
  setFolderScanning: (scanning: boolean) => void;
  setCurrentIndex: (index: number) => void;
  navigateNext: (loop?: boolean) => boolean;
  navigatePrev: (loop?: boolean) => boolean;
  navigateFirst: () => void;
  navigateLast: () => void;
  removeImage: (index: number) => void;

  setFullscreen: (fs: boolean) => void;
  setDefaultZoomMode: (mode: ZoomMode) => void;
  setZoomMode: (mode: ZoomMode) => void;
  setZoomLevel: (level: number) => void;
  setPan: (x: number, y: number) => void;
  resetZoom: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  rotateClockwise: () => void;
  rotateCounterClockwise: () => void;

  startSlideshow: () => void;
  stopSlideshow: () => void;
  toggleSlideshowPause: () => void;

  setShowControls: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setError: (msg: string | null) => void;
  saveRotation: () => Promise<void>;
  setViewMode: (mode: 'viewer' | 'grid') => void;
  beginLoadGeneration: () => number;
  reset: () => void;
}

const initialState = {
  currentImagePath: null,
  folderPath: null,
  images: [],
  currentIndex: -1,
  isFolderScanning: false,
  isFullscreen: false,
  defaultZoomMode: 'fit' as ZoomMode,
  zoomMode: 'fit' as ZoomMode,
  zoomLevel: 1,
  panX: 0,
  panY: 0,
  rotation: 0,
  isSlideshowActive: false,
  isSlideshowPaused: false,
  showControls: true,
  showSettings: false,
  errorMessage: null,
  cacheBuster: 0,
  loadGeneration: 0,
  viewMode: 'viewer' as const,
};

export const useViewerStore = create<ViewerState>((set, get) => ({
  ...initialState,

  setCurrentImage: (path, index) =>
    set({
      currentImagePath: path,
      currentIndex: index,
      zoomMode: get().defaultZoomMode,
      zoomLevel: 1,
      panX: 0,
      panY: 0,
      rotation: 0,
      errorMessage: null,
    }),

  setImages: (images) => set({ images }),

  setFolderPath: (path) => set({ folderPath: path }),

  setFolderScanning: (scanning) => set({ isFolderScanning: scanning }),

  setCurrentIndex: (index: number) => {
    const { images, defaultZoomMode } = get();
    if (index < 0 || index >= images.length) return;
    set({
      currentIndex: index,
      currentImagePath: images[index].path,
      zoomMode: defaultZoomMode,
      zoomLevel: 1,
      panX: 0,
      panY: 0,
      rotation: 0,
      errorMessage: null,
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
    const { images, currentIndex } = get();
    if (index < 0 || index >= images.length) return;
    
    const newImages = [...images];
    newImages.splice(index, 1);
    
    if (newImages.length === 0) {
      get().reset();
    } else {
      set({ images: newImages });
      // If we deleted the current or a previous image, update the current index
      if (currentIndex >= newImages.length) {
        get().setCurrentIndex(newImages.length - 1);
      } else if (index === currentIndex) {
        // Just trigger the same index to refresh currentImagePath
        get().setCurrentIndex(currentIndex);
      } else if (index < currentIndex) {
        // Adjust index down since a previous item was removed
        get().setCurrentIndex(currentIndex - 1);
      }
    }
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

  resetZoom: () =>
    set({ zoomMode: 'fit', zoomLevel: 1, panX: 0, panY: 0 }),

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
    set({ rotation: (rotation + 90) % 360 });
  },
  
  rotateCounterClockwise: () => {
    const { rotation } = get();
    set({ rotation: (rotation - 90 + 360) % 360 });
  },

  startSlideshow: () =>
    set({ isSlideshowActive: true, isSlideshowPaused: false }),

  stopSlideshow: () =>
    set({ isSlideshowActive: false, isSlideshowPaused: false }),

  toggleSlideshowPause: () => {
    const { isSlideshowPaused } = get();
    set({ isSlideshowPaused: !isSlideshowPaused });
  },

  setShowControls: (show) => set({ showControls: show }),
  setShowSettings: (show) => set({ showSettings: show }),
  setError: (msg) => set({ errorMessage: msg }),
  
  saveRotation: async () => {
    const { currentImagePath, rotation } = get();
    if (!currentImagePath || rotation === 0) return;
    
    try {
      const { saveRotatedImage } = await import('../services/tauriCommands');
      await saveRotatedImage(currentImagePath, rotation);
      invalidateImageAsset(currentImagePath);
      invalidateThumbnail(currentImagePath);
      set({ rotation: 0, cacheBuster: Date.now() });
    } catch (err) {
      set({ errorMessage: `Failed to save rotation: ${err}` });
    }
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  beginLoadGeneration: () => {
    const nextGeneration = get().loadGeneration + 1;
    set({ loadGeneration: nextGeneration });
    return nextGeneration;
  },

  reset: () =>
    set((state) => ({
      ...initialState,
      defaultZoomMode: state.defaultZoomMode,
      loadGeneration: state.loadGeneration + 1,
    })),
}));

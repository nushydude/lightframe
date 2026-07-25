import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useViewerStore } from '../state/viewerStore';
import type { KeyboardHandlers } from '../services/keyboardShortcutDispatcher';
import {
  copyCurrentImagePath,
  deleteCurrentImage,
  openCurrentImageInEditor,
} from '../services/viewerActions';

export function useAppKeyboardShortcuts({
  openFilePicker,
  goNext,
  goPrev,
  goFirst,
  goLast,
  refreshFolder,
  startSlideshow,
  stopSlideshow,
  toggleSlideshowPause,
  openCommandPalette,
  togglePerformanceTelemetry,
  handleExitGridView,
  toggleFavorite,
  setRating,
}: {
  openFilePicker: KeyboardHandlers['openFilePicker'];
  goNext: KeyboardHandlers['goNext'];
  goPrev: KeyboardHandlers['goPrev'];
  goFirst: KeyboardHandlers['goFirst'];
  goLast: KeyboardHandlers['goLast'];
  refreshFolder: KeyboardHandlers['refreshFolder'];
  startSlideshow: KeyboardHandlers['startSlideshow'];
  stopSlideshow: KeyboardHandlers['stopSlideshow'];
  toggleSlideshowPause: KeyboardHandlers['toggleSlideshowPause'];
  openCommandPalette: KeyboardHandlers['openCommandPalette'];
  togglePerformanceTelemetry: KeyboardHandlers['togglePerformanceTelemetry'];
  handleExitGridView: () => Promise<boolean>;
  toggleFavorite: (path: string) => Promise<unknown>;
  setRating: (path: string, rating: number) => Promise<unknown>;
}) {
  const handlers: KeyboardHandlers = {
    openFilePicker,
    openCurrentImageInEditor: () =>
      openCurrentImageInEditor(useViewerStore.getState().currentImagePath),
    copyCurrentImagePath: () => copyCurrentImagePath(useViewerStore.getState().currentImagePath),
    goNext,
    goPrev,
    goFirst,
    goLast,
    refreshFolder,
    deleteCurrentImage: () =>
      deleteCurrentImage({
        currentImagePath: useViewerStore.getState().currentImagePath,
        currentIndex: useViewerStore.getState().currentIndex,
        removeImage: useViewerStore.getState().removeImage,
      }),
    startSlideshow,
    stopSlideshow,
    toggleSlideshowPause,
    openCommandPalette,
    toggleGridView: () => {
      const state = useViewerStore.getState();
      if (state.viewMode === 'viewer') {
        state.setViewMode('grid');
        return;
      }
      void handleExitGridView();
    },
    togglePerformanceTelemetry,
    toggleFavoriteCurrent: () => {
      const path = useViewerStore.getState().currentImagePath;
      if (path) void toggleFavorite(path);
    },
    toggleMarkedCurrent: () => {
      const path = useViewerStore.getState().currentImagePath;
      if (path) useViewerStore.getState().toggleMarkedPath(path);
    },
    setRatingCurrent: (rating) => {
      const path = useViewerStore.getState().currentImagePath;
      if (path) void setRating(path, rating);
    },
  };

  useKeyboardShortcuts(handlers);
}

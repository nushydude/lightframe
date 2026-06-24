import { useEffect, useCallback } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { nudgeCropRectInDirection } from '../services/cropMath';
import {
  beginNavigationKeydownTelemetry,
  cancelPendingNavigationKeydownTelemetry,
} from '../services/performanceTelemetry';
import { revealCurrentImage } from '../services/viewerActions';

interface KeyboardHandlers {
  openFilePicker: () => void;
  openCurrentImageInEditor: () => void | Promise<void>;
  copyCurrentImagePath: () => void | Promise<void>;
  goNext: (loop?: boolean) => boolean;
  goPrev: (loop?: boolean) => boolean;
  goFirst: () => void;
  goLast: () => void;
  refreshFolder: () => void;
  deleteCurrentImage: () => void | Promise<void>;
  startSlideshow: () => void;
  stopSlideshow: () => void | Promise<void>;
  toggleSlideshowPause: () => void;
  openCommandPalette: () => void;
  toggleGridView: () => void;
  togglePerformanceTelemetry: () => void;
  toggleFavoriteCurrent: () => void;
  toggleMarkedCurrent: () => void;
  setRatingCurrent: (rating: number) => void;
}

/** Hook for handling all keyboard shortcuts */
export function useKeyboardShortcuts(handlers: KeyboardHandlers) {
  const {
    isFullscreen,
    isSlideshowActive,
    showSettings,
    showCommandPalette,
    currentImagePath,
    viewMode,
    isCropMode,
    cropRect,
    setFullscreen,
    setShowSettings,
    zoomIn,
    zoomOut,
    resetZoom,
    zoomMode,
    setZoomMode,
    updateCropRect,
    applyCropPreview,
    exitCropMode,
    exitCompareMode,
    switchCompareFocus,
    moveCompareFocusedCandidate,
    promoteFocusedComparePane,
  } = useViewerStore();

  const settings = useSettingsStore((s) => s.settings);

  const handleKeyDown = useCallback(
    // fallow-ignore-next-line complexity
    async (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      ) {
        return;
      }

      // Ctrl + O: Open file
      if (e.ctrlKey && e.key === 'o') {
        e.preventDefault();
        handlers.openFilePicker();
        return;
      }

      // Ctrl + E: Open in configured external editor
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        if (currentImagePath) {
          void handlers.openCurrentImageInEditor();
        }
        return;
      }

      // Ctrl + Shift + O: Show in folder
      if (e.ctrlKey && e.shiftKey && e.key === 'O') {
        e.preventDefault();
        void revealCurrentImage(currentImagePath);
        return;
      }

      // Ctrl + Shift + C: Copy the current image path
      if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        if (currentImagePath) {
          void handlers.copyCurrentImagePath();
        }
        return;
      }

      // Ctrl + ,: Toggle settings
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        setShowSettings(!showSettings);
        return;
      }

      // Ctrl + K / Ctrl + Shift + P: Open command palette
      if (
        (e.ctrlKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) ||
        (e.ctrlKey && e.shiftKey && (e.key === 'p' || e.key === 'P'))
      ) {
        e.preventDefault();
        if (!showCommandPalette) {
          handlers.openCommandPalette();
        }
        return;
      }

      if (e.ctrlKey && e.shiftKey && e.key === 'F12') {
        e.preventDefault();
        handlers.togglePerformanceTelemetry();
        return;
      }

      if (showCommandPalette) {
        return;
      }

      if (isCropMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          exitCropMode();
          return;
        }

        if (e.key === 'Enter') {
          e.preventDefault();
          applyCropPreview();
          return;
        }

        if (!cropRect) {
          return;
        }

        const activeImage = document.querySelector('.image-canvas img') as HTMLImageElement | null;
        const imageWidth = activeImage?.naturalWidth ?? activeImage?.width ?? 1;
        const imageHeight = activeImage?.naturalHeight ?? activeImage?.height ?? 1;

        if (
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight'
        ) {
          e.preventDefault();
          const stepPx = e.shiftKey ? 10 : 1;
          updateCropRect(
            nudgeCropRectInDirection(cropRect, e.key, stepPx, imageWidth, imageHeight)
          );
          return;
        }
      }

      if (viewMode === 'compare') {
        if (e.key === 'Escape') {
          e.preventDefault();
          exitCompareMode();
          return;
        }

        if (e.key === 'Tab') {
          e.preventDefault();
          switchCompareFocus();
          return;
        }

        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          moveCompareFocusedCandidate(-1);
          return;
        }

        if (e.key === 'ArrowRight') {
          e.preventDefault();
          moveCompareFocusedCandidate(1);
          return;
        }

        if (e.key === 'Enter') {
          e.preventDefault();
          promoteFocusedComparePane();
          return;
        }
      }

      // Ctrl + 0: Reset zoom to fit
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        resetZoom();
        return;
      }

      // Ctrl + R: Refresh current folder
      if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        handlers.refreshFolder();
        return;
      }

      // Escape: Close settings > stop slideshow > reset zoom > exit fullscreen
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showSettings) {
          setShowSettings(false);
        } else if (isSlideshowActive) {
          await handlers.stopSlideshow();
        } else if (zoomMode !== 'fit') {
          setZoomMode('fit');
        } else if (isFullscreen) {
          try {
            const appWindow = getCurrentWindow();
            await appWindow.setFullscreen(false);
            setFullscreen(false);
          } catch (err) {
            console.error('Failed to exit fullscreen:', err);
          }
        }
        return;
      }

      // F11: Toggle fullscreen
      if (e.key === 'F11') {
        e.preventDefault();
        try {
          const appWindow = getCurrentWindow();
          const newFs = !isFullscreen;
          await appWindow.setFullscreen(newFs);
          setFullscreen(newFs);
        } catch (err) {
          console.error('Failed to toggle fullscreen:', err);
        }
        return;
      }

      // F5: Start slideshow
      if (e.key === 'F5') {
        e.preventDefault();
        if (!isSlideshowActive) {
          handlers.startSlideshow();
        }
        return;
      }

      // F6: Refresh current folder
      if (e.key === 'F6') {
        e.preventDefault();
        handlers.refreshFolder();
        return;
      }

      // G: Toggle grid view
      if ((e.key === 'g' || e.key === 'G') && currentImagePath) {
        e.preventDefault();
        handlers.toggleGridView();
        return;
      }

      // F: Toggle favorite
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if (currentImagePath) {
          handlers.toggleFavoriteCurrent();
        }
        return;
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        if (currentImagePath) {
          handlers.toggleMarkedCurrent();
        }
        return;
      }

      // Alt + 0..5: Set image rating
      if (!e.ctrlKey && !e.metaKey && e.altKey && !e.shiftKey && /^[0-5]$/.test(e.key)) {
        e.preventDefault();
        if (currentImagePath) {
          handlers.setRatingCurrent(Number(e.key));
        }
        return;
      }

      if (viewMode === 'grid') {
        return;
      }

      // Delete: move current image to trash
      if (e.key === 'Delete') {
        e.preventDefault();
        if (currentImagePath) {
          await handlers.deleteCurrentImage();
        }
        return;
      }

      // Space: next image OR pause/resume slideshow
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (isSlideshowActive) {
          handlers.toggleSlideshowPause();
        } else {
          beginNavigationKeydownTelemetry('next');
          if (!handlers.goNext()) {
            cancelPendingNavigationKeydownTelemetry();
          }
        }
        return;
      }

      // Right Arrow: next image
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        beginNavigationKeydownTelemetry('next');
        if (!handlers.goNext(settings.loopSlideshow)) {
          cancelPendingNavigationKeydownTelemetry();
        }
        return;
      }

      // Left Arrow: previous image
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        beginNavigationKeydownTelemetry('prev');
        if (!handlers.goPrev(settings.loopSlideshow)) {
          cancelPendingNavigationKeydownTelemetry();
        }
        return;
      }

      // Home: first image
      if (e.key === 'Home') {
        e.preventDefault();
        handlers.goFirst();
        return;
      }

      // End: last image
      if (e.key === 'End') {
        e.preventDefault();
        handlers.goLast();
        return;
      }

      // 0: Recenter and fit
      if (e.key === '0' && !e.ctrlKey) {
        e.preventDefault();
        resetZoom();
        return;
      }

      // 1: Actual size
      if (e.key === '1' && !e.ctrlKey) {
        e.preventDefault();
        setZoomMode('actual');
        return;
      }

      // + or =: Zoom in
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
        return;
      }

      // -: Zoom out
      if (e.key === '-' && !e.ctrlKey) {
        e.preventDefault();
        zoomOut();
        return;
      }

      // I: Toggle image info / EXIF panel
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('toggle-exif'));
        return;
      }

      // L: Rotate counter-clockwise
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        useViewerStore.getState().rotateCounterClockwise();
        return;
      }

      // R: Rotate clockwise
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        useViewerStore.getState().rotateClockwise();
        return;
      }
    },
    [
      handlers,
      isFullscreen,
      isSlideshowActive,
      showSettings,
      showCommandPalette,
      currentImagePath,
      viewMode,
      isCropMode,
      cropRect,
      settings.loopSlideshow,
      setFullscreen,
      setShowSettings,
      zoomMode,
      setZoomMode,
      zoomIn,
      zoomOut,
      resetZoom,
      updateCropRect,
      applyCropPreview,
      exitCropMode,
      exitCompareMode,
      switchCompareFocus,
      moveCompareFocusedCandidate,
      promoteFocusedComparePane,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

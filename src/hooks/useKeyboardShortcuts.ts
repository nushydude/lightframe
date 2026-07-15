import { useEffect, useCallback, useRef } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { revealCurrentImage } from '../services/viewerActions';
import {
  dispatchCompareShortcut,
  dispatchCropShortcut,
  dispatchViewerShortcut,
  type KeyboardHandlers,
} from '../services/keyboardShortcutDispatcher';

/** Hook for handling all keyboard shortcuts */
export function useKeyboardShortcuts(handlers: KeyboardHandlers) {
  const isFullscreen = useViewerStore((state) => state.isFullscreen);
  const isSlideshowActive = useViewerStore((state) => state.isSlideshowActive);
  const showSettings = useViewerStore((state) => state.showSettings);
  const showCommandPalette = useViewerStore((state) => state.showCommandPalette);
  const currentImagePath = useViewerStore((state) => state.currentImagePath);
  const viewMode = useViewerStore((state) => state.viewMode);
  const isCropMode = useViewerStore((state) => state.isCropMode);
  const cropRect = useViewerStore((state) => state.cropRect);
  const setFullscreen = useViewerStore((state) => state.setFullscreen);
  const setShowSettings = useViewerStore((state) => state.setShowSettings);
  const zoomIn = useViewerStore((state) => state.zoomIn);
  const zoomOut = useViewerStore((state) => state.zoomOut);
  const resetZoom = useViewerStore((state) => state.resetZoom);
  const zoomMode = useViewerStore((state) => state.zoomMode);
  const setZoomMode = useViewerStore((state) => state.setZoomMode);
  const updateCropRect = useViewerStore((state) => state.updateCropRect);
  const applyCropPreview = useViewerStore((state) => state.applyCropPreview);
  const exitCropMode = useViewerStore((state) => state.exitCropMode);
  const exitCompareMode = useViewerStore((state) => state.exitCompareMode);
  const switchCompareFocus = useViewerStore((state) => state.switchCompareFocus);
  const moveCompareFocusedCandidate = useViewerStore((state) => state.moveCompareFocusedCandidate);
  const promoteFocusedComparePane = useViewerStore((state) => state.promoteFocusedComparePane);

  const loopSlideshow = useSettingsStore((state) => state.settings.loopSlideshow);
  const lastUnhandledEscapeAtRef = useRef<number | null>(null);

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

      const cropResult = dispatchCropShortcut(e, {
        isCropMode,
        cropRect,
        updateCropRect,
        applyCropPreview,
        exitCropMode,
      });
      if (cropResult !== 'unmatched') return;

      if (
        dispatchCompareShortcut(e, {
          isCompareMode: viewMode === 'compare',
          exitCompareMode,
          switchCompareFocus,
          moveCompareFocusedCandidate,
          promoteFocusedComparePane,
        })
      ) {
        return;
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
        const clearPendingEscapeQuit = () => {
          lastUnhandledEscapeAtRef.current = null;
        };

        if (showSettings) {
          clearPendingEscapeQuit();
          setShowSettings(false);
        } else if (isSlideshowActive) {
          clearPendingEscapeQuit();
          await handlers.stopSlideshow();
        } else if (zoomMode !== 'fit') {
          clearPendingEscapeQuit();
          setZoomMode('fit');
        } else if (isFullscreen) {
          clearPendingEscapeQuit();
          try {
            const appWindow = getCurrentWindow();
            await appWindow.setFullscreen(false);
            setFullscreen(false);
          } catch (err) {
            console.error('Failed to exit fullscreen:', err);
          }
        } else {
          const now = Date.now();
          if (
            lastUnhandledEscapeAtRef.current !== null &&
            now - lastUnhandledEscapeAtRef.current <= 500
          ) {
            clearPendingEscapeQuit();
            try {
              await getCurrentWindow().close();
            } catch (err) {
              console.error('Failed to close window after double Escape:', err);
            }
          } else {
            lastUnhandledEscapeAtRef.current = now;
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

      dispatchViewerShortcut(e, {
        viewMode,
        currentImagePath,
        isSlideshowActive,
        loopSlideshow,
        handlers,
        resetZoom,
        setZoomMode,
        zoomIn,
        zoomOut,
      });
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
      loopSlideshow,
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

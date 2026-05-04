import { useEffect, useCallback } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface KeyboardHandlers {
  openFilePicker: () => void;
  goNext: (loop?: boolean) => boolean;
  goPrev: (loop?: boolean) => boolean;
  goFirst: () => void;
  goLast: () => void;
  startSlideshow: () => void;
  stopSlideshow: () => void;
  toggleSlideshowPause: () => void;
}

/** Hook for handling all keyboard shortcuts */
export function useKeyboardShortcuts(handlers: KeyboardHandlers) {
  const {
    isFullscreen,
    isSlideshowActive,
    showSettings,
    setFullscreen,
    setShowSettings,
    zoomIn,
    zoomOut,
    resetZoom,
    zoomMode,
    setZoomMode,
    stopSlideshow,
  } = useViewerStore();

  const settings = useSettingsStore((s) => s.settings);

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        return;
      }

      // Ctrl + O: Open file
      if (e.ctrlKey && e.key === 'o') {
        e.preventDefault();
        handlers.openFilePicker();
        return;
      }

      // Ctrl + ,: Toggle settings
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        setShowSettings(!showSettings);
        return;
      }

      // Ctrl + 0: Reset zoom to fit
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        resetZoom();
        return;
      }

      // Escape: Close settings > stop slideshow > reset zoom > exit fullscreen
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showSettings) {
          setShowSettings(false);
        } else if (isSlideshowActive) {
          handlers.stopSlideshow();
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

      // Space: next image OR pause/resume slideshow
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (isSlideshowActive) {
          handlers.toggleSlideshowPause();
        } else {
          handlers.goNext();
        }
        return;
      }

      // Right Arrow: next image
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        handlers.goNext(settings.loopSlideshow);
        return;
      }

      // Left Arrow: previous image
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlers.goPrev(settings.loopSlideshow);
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

      // 0: Fit to screen
      if (e.key === '0' && !e.ctrlKey) {
        e.preventDefault();
        setZoomMode('fit');
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
    },
    [
      handlers,
      isFullscreen,
      isSlideshowActive,
      showSettings,
      settings.loopSlideshow,
      setFullscreen,
      setShowSettings,
      zoomMode,
      setZoomMode,
      zoomIn,
      zoomOut,
      resetZoom,
      stopSlideshow,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

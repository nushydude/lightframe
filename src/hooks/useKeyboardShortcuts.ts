import { useEffect, useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import {
  dispatchApplicationShortcut,
  dispatchCompareShortcut,
  dispatchCropShortcut,
  dispatchViewerShortcut,
  type KeyboardHandlers,
} from '../services/keyboardShortcutDispatcher';

/** Hook for handling all keyboard shortcuts */
export function useKeyboardShortcuts(handlers: KeyboardHandlers) {
  const viewerState = useViewerStore(
    useShallow((state) => ({
      isFullscreen: state.isFullscreen,
      isSlideshowActive: state.isSlideshowActive,
      showSettings: state.showSettings,
      showCommandPalette: state.showCommandPalette,
      currentImagePath: state.currentImagePath,
      viewMode: state.viewMode,
      isCropMode: state.isCropMode,
      cropRect: state.cropRect,
      setFullscreen: state.setFullscreen,
      setShowSettings: state.setShowSettings,
      zoomIn: state.zoomIn,
      zoomOut: state.zoomOut,
      resetZoom: state.resetZoom,
      zoomMode: state.zoomMode,
      setZoomMode: state.setZoomMode,
      updateCropRect: state.updateCropRect,
      applyCropPreview: state.applyCropPreview,
      exitCropMode: state.exitCropMode,
      exitCompareMode: state.exitCompareMode,
      switchCompareFocus: state.switchCompareFocus,
      moveCompareFocusedCandidate: state.moveCompareFocusedCandidate,
      promoteFocusedComparePane: state.promoteFocusedComparePane,
    }))
  );
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
  } = viewerState;

  const loopSlideshow = useSettingsStore((state) => state.settings.loopSlideshow);
  const lastUnhandledEscapeAtRef = useRef<number | null>(null);

  const handleKeyDown = useCallback(
    // fallow-ignore-next-line complexity -- keyboard command dispatch boundary
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

      if (
        dispatchApplicationShortcut(e, {
          currentImagePath,
          isFullscreen,
          isSlideshowActive,
          showSettings,
          showCommandPalette,
          isCompareMode: viewMode === 'compare',
          loopSlideshow,
          zoomMode,
          setFullscreen,
          setShowSettings,
          setZoomMode,
          handlers,
          lastUnhandledEscapeAtRef,
        })
      )
        return;

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

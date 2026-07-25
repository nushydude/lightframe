import type { NormalizedCropRect } from './cropMath';
import { nudgeCropRectInDirection } from './cropMath';
import {
  beginNavigationKeydownTelemetry,
  cancelPendingNavigationKeydownTelemetry,
} from './performanceTelemetry';
import { useViewerStore } from '../state/viewerStore';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { revealCurrentImage } from './viewerActions';

export interface KeyboardHandlers {
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

export interface ApplicationShortcutContext {
  currentImagePath: string | null;
  isFullscreen: boolean;
  isSlideshowActive: boolean;
  showSettings: boolean;
  showCommandPalette: boolean;
  isCompareMode: boolean;
  loopSlideshow: boolean;
  zoomMode: 'fit' | 'fill' | 'actual' | 'custom';
  setFullscreen: (fullscreen: boolean) => void;
  setShowSettings: (visible: boolean) => void;
  setZoomMode: (mode: 'fit' | 'fill' | 'actual' | 'custom') => void;
  handlers: KeyboardHandlers;
  lastUnhandledEscapeAtRef: { current: number | null };
}

function dispatchFileShortcut(event: KeyboardEvent, context: ApplicationShortcutContext): boolean {
  const { handlers } = context;
  if (!event.ctrlKey) return false;
  if (event.key === 'o') {
    event.preventDefault();
    handlers.openFilePicker();
    return true;
  }
  if (!event.shiftKey && !event.altKey && ['e', 'E'].includes(event.key)) {
    event.preventDefault();
    if (context.currentImagePath) void handlers.openCurrentImageInEditor();
    return true;
  }
  if (event.shiftKey && event.key === 'O') {
    event.preventDefault();
    void revealCurrentImage(context.currentImagePath);
    return true;
  }
  if (event.shiftKey && ['c', 'C'].includes(event.key)) {
    event.preventDefault();
    if (context.currentImagePath) void handlers.copyCurrentImagePath();
    return true;
  }
  return false;
}

function dispatchPanelShortcut(event: KeyboardEvent, context: ApplicationShortcutContext): boolean {
  const { handlers } = context;
  if (!event.ctrlKey) return false;
  if (event.key === ',') {
    event.preventDefault();
    context.setShowSettings(!context.showSettings);
    return true;
  }
  if (
    (!event.shiftKey && ['k', 'K'].includes(event.key)) ||
    (event.shiftKey && ['p', 'P'].includes(event.key))
  ) {
    event.preventDefault();
    if (!context.showCommandPalette) handlers.openCommandPalette();
    return true;
  }
  if (event.shiftKey && event.key === 'F12') {
    event.preventDefault();
    handlers.togglePerformanceTelemetry();
    return true;
  }
  return false;
}

function dispatchApplicationModifierShortcut(
  event: KeyboardEvent,
  context: ApplicationShortcutContext
): boolean {
  return dispatchFileShortcut(event, context) || dispatchPanelShortcut(event, context);
}

function dispatchEscapeShortcut(
  event: KeyboardEvent,
  context: ApplicationShortcutContext
): boolean {
  if (event.key !== 'Escape' || context.isCompareMode) return false;
  const { handlers } = context;

  event.preventDefault();
  const clearPendingEscapeQuit = () => {
    context.lastUnhandledEscapeAtRef.current = null;
  };
  if (context.showSettings) {
    clearPendingEscapeQuit();
    context.setShowSettings(false);
  } else if (context.isSlideshowActive) {
    clearPendingEscapeQuit();
    void handlers.stopSlideshow();
  } else if (context.zoomMode !== 'fit') {
    clearPendingEscapeQuit();
    context.setZoomMode('fit');
  } else if (context.isFullscreen) {
    clearPendingEscapeQuit();
    void exitFullscreen(context);
  } else {
    handleEscapeQuit(context, clearPendingEscapeQuit);
  }
  return true;
}

function exitFullscreen(context: ApplicationShortcutContext): Promise<void> {
  return getCurrentWindow()
    .setFullscreen(false)
    .then(() => context.setFullscreen(false))
    .catch((error) => console.error('Failed to exit fullscreen:', error));
}

function handleEscapeQuit(
  context: ApplicationShortcutContext,
  clearPendingEscapeQuit: () => void
): void {
  const now = Date.now();
  if (
    context.lastUnhandledEscapeAtRef.current !== null &&
    now - context.lastUnhandledEscapeAtRef.current <= 500
  ) {
    clearPendingEscapeQuit();
    void getCurrentWindow()
      .close()
      .catch((error) => {
        console.error('Failed to close window after double Escape:', error);
      });
    return;
  }
  context.lastUnhandledEscapeAtRef.current = now;
}

function dispatchWindowShortcut(
  event: KeyboardEvent,
  context: ApplicationShortcutContext
): boolean {
  const { handlers } = context;
  if (event.key === 'F11') {
    event.preventDefault();
    try {
      const newFullscreen = !context.isFullscreen;
      void getCurrentWindow()
        .setFullscreen(newFullscreen)
        .then(() => context.setFullscreen(newFullscreen))
        .catch((error) => {
          console.error('Failed to toggle fullscreen:', error);
        });
    } catch (error) {
      console.error('Failed to toggle fullscreen:', error);
    }
    return true;
  }
  if (event.key === 'F5') {
    event.preventDefault();
    if (!context.isSlideshowActive) handlers.startSlideshow();
    return true;
  }
  if (event.key === 'F6') {
    event.preventDefault();
    handlers.refreshFolder();
    return true;
  }
  if (event.ctrlKey && event.key === '0') {
    event.preventDefault();
    context.setZoomMode('fit');
    return true;
  }
  if (event.ctrlKey && ['r', 'R'].includes(event.key)) {
    event.preventDefault();
    handlers.refreshFolder();
    return true;
  }
  return false;
}

function dispatchCurationActionShortcut(
  event: KeyboardEvent,
  context: ApplicationShortcutContext
): boolean {
  const { handlers } = context;
  if (['g', 'G'].includes(event.key) && context.currentImagePath) {
    event.preventDefault();
    handlers.toggleGridView();
    return true;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && ['f', 'F'].includes(event.key)) {
    event.preventDefault();
    if (context.currentImagePath) handlers.toggleFavoriteCurrent();
    return true;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && ['m', 'M'].includes(event.key)) {
    event.preventDefault();
    if (context.currentImagePath) handlers.toggleMarkedCurrent();
    return true;
  }
  return false;
}

function dispatchRatingShortcut(
  event: KeyboardEvent,
  context: ApplicationShortcutContext
): boolean {
  if (
    !event.ctrlKey &&
    !event.metaKey &&
    event.altKey &&
    !event.shiftKey &&
    /^[0-5]$/.test(event.key)
  ) {
    event.preventDefault();
    if (context.currentImagePath) context.handlers.setRatingCurrent(Number(event.key));
    return true;
  }
  return false;
}

function dispatchDirectApplicationShortcut(
  event: KeyboardEvent,
  context: ApplicationShortcutContext
): boolean {
  return dispatchCurationActionShortcut(event, context) || dispatchRatingShortcut(event, context);
}

/** Handles shortcuts owned by the application shell rather than the viewer. */
export function dispatchApplicationShortcut(
  event: KeyboardEvent,
  context: ApplicationShortcutContext
): boolean {
  if (dispatchApplicationModifierShortcut(event, context)) return true;
  if (context.showCommandPalette) return true;
  if (dispatchEscapeShortcut(event, context)) return true;
  if (dispatchWindowShortcut(event, context)) return true;
  return dispatchDirectApplicationShortcut(event, context);
}

export function dispatchCropShortcut(
  event: KeyboardEvent,
  context: {
    isCropMode: boolean;
    cropRect: NormalizedCropRect | null;
    updateCropRect: (rect: NormalizedCropRect) => void;
    applyCropPreview: () => void;
    exitCropMode: () => void;
  }
): 'handled' | 'blocked' | 'unmatched' {
  if (!context.isCropMode) return 'unmatched';
  if (event.key === 'Escape') {
    event.preventDefault();
    context.exitCropMode();
    return 'handled';
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    context.applyCropPreview();
    return 'handled';
  }
  if (!context.cropRect) return 'blocked';
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    return 'unmatched';
  }

  event.preventDefault();
  const image = document.querySelector('.image-canvas img') as HTMLImageElement | null;
  const imageWidth = image?.naturalWidth ?? image?.width ?? 1;
  const imageHeight = image?.naturalHeight ?? image?.height ?? 1;
  context.updateCropRect(
    nudgeCropRectInDirection(
      context.cropRect,
      event.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
      event.shiftKey ? 10 : 1,
      imageWidth,
      imageHeight
    )
  );
  return 'handled';
}

export function dispatchCompareShortcut(
  event: KeyboardEvent,
  context: {
    isCompareMode: boolean;
    exitCompareMode: () => void;
    switchCompareFocus: () => void;
    moveCompareFocusedCandidate: (offset: -1 | 1) => void;
    promoteFocusedComparePane: () => void;
  }
): boolean {
  if (!context.isCompareMode) return false;
  const action = {
    Escape: context.exitCompareMode,
    Tab: context.switchCompareFocus,
    ArrowLeft: () => context.moveCompareFocusedCandidate(-1),
    ArrowRight: () => context.moveCompareFocusedCandidate(1),
    Enter: context.promoteFocusedComparePane,
  }[event.key];
  if (!action) return false;
  event.preventDefault();
  action();
  return true;
}

export interface ViewerShortcutContext {
  viewMode: 'viewer' | 'grid' | 'compare';
  currentImagePath: string | null;
  isSlideshowActive: boolean;
  loopSlideshow: boolean;
  handlers: KeyboardHandlers;
  resetZoom: () => void;
  setZoomMode: (mode: 'fit' | 'fill' | 'actual' | 'custom') => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

function dispatchDeleteShortcut(event: KeyboardEvent, context: ViewerShortcutContext): boolean {
  if (event.key !== 'Delete') return false;
  event.preventDefault();
  if (context.currentImagePath) void context.handlers.deleteCurrentImage();
  return true;
}

function dispatchSpaceShortcut(event: KeyboardEvent, context: ViewerShortcutContext): boolean {
  if (event.key !== ' ' && event.code !== 'Space') return false;
  event.preventDefault();
  if (context.isSlideshowActive) {
    context.handlers.toggleSlideshowPause();
  } else {
    beginNavigationKeydownTelemetry('next');
    if (!context.handlers.goNext()) cancelPendingNavigationKeydownTelemetry();
  }
  return true;
}

function dispatchDirectionalNavigationShortcut(
  event: KeyboardEvent,
  context: ViewerShortcutContext
): boolean {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return false;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 'next' : 'prev';
  beginNavigationKeydownTelemetry(direction);
  const moved =
    direction === 'next'
      ? context.handlers.goNext(context.loopSlideshow)
      : context.handlers.goPrev(context.loopSlideshow);
  if (!moved) cancelPendingNavigationKeydownTelemetry();
  return true;
}

function dispatchNavigationShortcut(event: KeyboardEvent, context: ViewerShortcutContext): boolean {
  if (dispatchDeleteShortcut(event, context)) return true;
  if (dispatchSpaceShortcut(event, context)) return true;
  return dispatchDirectionalNavigationShortcut(event, context);
}

function dispatchViewerCommandShortcut(event: KeyboardEvent, context: ViewerShortcutContext): void {
  const { handlers } = context;
  const action = {
    Home: handlers.goFirst,
    End: handlers.goLast,
    '0': context.resetZoom,
    '1': () => context.setZoomMode('actual'),
    '+': context.zoomIn,
    '=': context.zoomIn,
    '-': context.zoomOut,
    i: () => window.dispatchEvent(new CustomEvent('toggle-exif')),
    I: () => window.dispatchEvent(new CustomEvent('toggle-exif')),
    l: () => useViewerStore.getState().rotateCounterClockwise(),
    L: () => useViewerStore.getState().rotateCounterClockwise(),
    r: () => useViewerStore.getState().rotateClockwise(),
    R: () => useViewerStore.getState().rotateClockwise(),
  }[event.key];

  if (!action || ((event.key === '0' || event.key === '1' || event.key === '-') && event.ctrlKey)) {
    return;
  }
  event.preventDefault();
  action();
}

export function dispatchViewerShortcut(event: KeyboardEvent, context: ViewerShortcutContext): void {
  if (context.viewMode === 'grid') return;
  if (dispatchNavigationShortcut(event, context)) return;
  dispatchViewerCommandShortcut(event, context);
}

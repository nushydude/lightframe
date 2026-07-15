import type { NormalizedCropRect } from './cropMath';
import { nudgeCropRectInDirection } from './cropMath';
import {
  beginNavigationKeydownTelemetry,
  cancelPendingNavigationKeydownTelemetry,
} from './performanceTelemetry';
import { useViewerStore } from '../state/viewerStore';

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

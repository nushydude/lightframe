type ViewMode = 'viewer' | 'grid' | 'compare';

function conditionalClass(condition: boolean, className: string) {
  return condition ? className : '';
}

export function getAppContainerClasses({
  isFullscreen,
  showControls,
  showThumbnails,
  currentImagePath,
  viewMode,
  isSecondary,
  isSlideshowActive,
}: {
  isFullscreen: boolean;
  showControls: boolean;
  showThumbnails: boolean;
  currentImagePath: string | null;
  viewMode: ViewMode;
  isSecondary: boolean;
  isSlideshowActive: boolean;
}) {
  const viewerMode = viewMode === 'viewer' && !isSecondary;
  const viewerActive = viewerMode && !isSlideshowActive;
  return [
    'app-container',
    conditionalClass(isFullscreen, 'fullscreen'),
    conditionalClass(showControls, 'controls-visible'),
    conditionalClass(
      showThumbnails && Boolean(currentImagePath) && viewerActive,
      'with-thumbnails'
    ),
    conditionalClass(Boolean(currentImagePath) && viewerActive, 'has-viewer-safe-areas'),
    conditionalClass(viewMode === 'grid' && !isSecondary, 'grid-mode'),
    conditionalClass(viewMode === 'compare' && !isSecondary, 'compare-mode'),
    conditionalClass(isSlideshowActive, 'slideshow-active'),
    conditionalClass(isSecondary, 'secondary-window'),
  ]
    .filter(Boolean)
    .join(' ');
}

import { useViewerStore } from '../state/viewerStore';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface ViewerChromeProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onNext: () => void;
  onPrev: () => void;
  onStartSlideshow: () => void;
  onTogglePause: () => void;
}

/** Top bar and navigation overlay controls */
export function ViewerChrome({
  onOpenFile,
  onOpenFolder,
  onNext,
  onPrev,
  onStartSlideshow,
  onTogglePause,
}: ViewerChromeProps) {
  const {
    currentImagePath,
    images,
    currentIndex,
    isFullscreen,
    isSlideshowActive,
    isSlideshowPaused,
    zoomMode,
    zoomLevel,
    isFolderScanning,
    setFullscreen,
    setShowSettings,
    setZoomMode,
    zoomIn,
    zoomOut,
  } = useViewerStore();

  const fileName = currentImagePath
    ? currentImagePath.replace(/\\/g, '/').split('/').pop() || ''
    : '';

  const toggleFullscreen = async () => {
    try {
      const appWindow = getCurrentWindow();
      const newFs = !isFullscreen;
      await appWindow.setFullscreen(newFs);
      setFullscreen(newFs);
    } catch (err) {
      console.error('Failed to toggle fullscreen:', err);
    }
  };

  const getZoomDisplay = () => {
    if (zoomMode === 'fit') return 'Fit';
    if (zoomMode === 'fill') return 'Fill';
    if (zoomMode === 'actual') return '100%';
    return `${Math.round(zoomLevel * 100)}%`;
  };

  if (!currentImagePath) return null;

  return (
    <>
      {/* Top Bar */}
      <div className="top-bar" role="toolbar" aria-label="Image information">
        <div className="top-bar-left">
          <span className="file-name" title={fileName}>{fileName}</span>
          {images.length > 0 && (
            <span className="image-counter">
              {currentIndex + 1} / {images.length}
              {isFolderScanning && ' …'}
            </span>
          )}
        </div>
        <div className="top-bar-right">
          <button
            className="top-bar-btn"
            onClick={onOpenFile}
            title="Open file (Ctrl+O)"
            aria-label="Open file"
            id="btn-open-file"
          >
            📄
          </button>
          <button
            className="top-bar-btn"
            onClick={onOpenFolder}
            title="Open folder"
            aria-label="Open folder"
            id="btn-open-folder"
          >
            📁
          </button>
          <button
            className="top-bar-btn"
            onClick={toggleFullscreen}
            title="Toggle fullscreen (F11)"
            aria-label="Toggle fullscreen"
            id="btn-fullscreen"
          >
            {isFullscreen ? '⊡' : '⊞'}
          </button>
          <button
            className="top-bar-btn"
            onClick={() => setShowSettings(true)}
            title="Settings (Ctrl+,)"
            aria-label="Open settings"
            id="btn-settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Navigation Arrows */}
      {images.length > 1 && (
        <>
          <button
            className="nav-arrow left"
            onClick={onPrev}
            aria-label="Previous image"
            id="btn-prev"
          >
            ‹
          </button>
          <button
            className="nav-arrow right"
            onClick={onNext}
            aria-label="Next image"
            id="btn-next"
          >
            ›
          </button>
        </>
      )}

      {/* Slideshow Indicator */}
      {isSlideshowActive && (
        <div className={`slideshow-indicator ${isSlideshowPaused ? 'paused' : ''}`}>
          {isSlideshowPaused ? '⏸ Paused' : '▶ Slideshow'}
        </div>
      )}

      {/* Bottom Controls */}
      <div className="bottom-controls" role="toolbar" aria-label="Image controls">
        <button
          className="control-btn"
          onClick={onPrev}
          title="Previous (←)"
          aria-label="Previous image"
          id="btn-ctrl-prev"
        >
          ⏮
        </button>

        {!isSlideshowActive ? (
          <button
            className="control-btn"
            onClick={onStartSlideshow}
            title="Start slideshow (F5)"
            aria-label="Start slideshow"
            id="btn-start-slideshow"
          >
            ▶
          </button>
        ) : (
          <button
            className={`control-btn ${isSlideshowPaused ? '' : 'active'}`}
            onClick={onTogglePause}
            title="Pause/Resume slideshow (Space)"
            aria-label="Toggle slideshow pause"
            id="btn-toggle-slideshow"
          >
            {isSlideshowPaused ? '▶' : '⏸'}
          </button>
        )}

        <button
          className="control-btn"
          onClick={onNext}
          title="Next (→)"
          aria-label="Next image"
          id="btn-ctrl-next"
        >
          ⏭
        </button>

        <div className="control-divider" />

        <button
          className="control-btn"
          onClick={zoomOut}
          title="Zoom out (-)"
          aria-label="Zoom out"
          id="btn-zoom-out"
        >
          −
        </button>

        <span className="zoom-display">{getZoomDisplay()}</span>

        <button
          className="control-btn"
          onClick={zoomIn}
          title="Zoom in (+)"
          aria-label="Zoom in"
          id="btn-zoom-in"
        >
          +
        </button>

        <div className="control-divider" />

        <button
          className={`control-btn ${zoomMode === 'fit' ? 'active' : ''}`}
          onClick={() => setZoomMode('fit')}
          title="Fit to screen (0)"
          aria-label="Fit to screen"
          id="btn-zoom-fit"
        >
          ⊡
        </button>

        <button
          className={`control-btn ${zoomMode === 'actual' ? 'active' : ''}`}
          onClick={() => setZoomMode('actual')}
          title="Actual size (1)"
          aria-label="Actual size"
          id="btn-zoom-actual"
        >
          1:1
        </button>
      </div>
    </>
  );
}

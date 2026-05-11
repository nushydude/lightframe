import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, message, save } from '@tauri-apps/plugin-dialog';
import { ExifPanel } from './ExifPanel';
import {
  getFileName,
  openSecondaryWindow,
  overwriteWithCrop,
  saveCroppedCopy,
} from '../services/tauriCommands';
import { useViewerStore } from '../state/viewerStore';
import {
  canSaveRotationForPath,
  copyCurrentImage,
  deleteCurrentImage,
  revealCurrentImage,
} from '../services/viewerActions';
import { normalizedToIntegerPixelRect } from '../services/cropMath';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { useCurationStore } from '../state/curationStore';

interface ViewerChromeProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onRefreshFolder: () => void;
  onGoHome: () => void;
  onNext: () => void;
  onPrev: () => void;
  onStartSlideshow: () => void;
  onTogglePause: () => void;
}

/** Top bar and navigation overlay controls */
export function ViewerChrome({
  onOpenFile,
  onOpenFolder,
  onRefreshFolder,
  onGoHome,
  onNext,
  onPrev,
  onStartSlideshow,
  onTogglePause,
}: ViewerChromeProps) {
  const {
    currentImagePath,
    images,
    currentIndex,
    folderPath,
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
    removeImage,
    rotation,
    isCropMode,
    cropRect,
    pendingCropPreview,
    pendingEditsByPath,
    cropAspectRatio,
    viewMode,
    setViewMode,
    enterCropMode,
    exitCropMode,
    setCropAspectRatio,
    resetCrop,
    applyCropPreview,
    clearCropPreview,
    clearPendingEdits,
    commitPendingEdits,
  } = useViewerStore();
  const curationByPath = useCurationStore((state) => state.curationByPath);
  const toggleFavorite = useCurationStore((state) => state.toggleFavorite);
  const setRating = useCurationStore((state) => state.setRating);

  const [showExif, setShowExif] = useState(false);
  const [exifRefreshToken, setExifRefreshToken] = useState(0);

  useEffect(() => {
    const handler = () => setShowExif((value) => !value);
    window.addEventListener('toggle-exif', handler);

    return () => {
      window.removeEventListener('toggle-exif', handler);
    };
  }, []);

  const fileName = currentImagePath
    ? currentImagePath.replace(/\\/g, '/').split('/').pop() || ''
    : '';
  const canSaveRotation = canSaveRotationForPath(currentImagePath);
  const cropDisabledByRotation = rotation !== 0;
  const canPreviewCrop = isCropMode && cropRect !== null;
  const currentPendingEdit = currentImagePath ? pendingEditsByPath[currentImagePath] : undefined;
  const hasPendingEdits = Boolean(currentPendingEdit);
  const canCommitPendingEdits =
    Boolean(currentPendingEdit?.cropRect) || (hasPendingEdits && canSaveRotation);
  const currentCuration = currentImagePath ? curationByPath[currentImagePath] : undefined;
  const isFavorite = Boolean(currentCuration?.favorite);
  const currentRating = currentCuration?.rating ?? 0;

  const toggleFullscreen = async () => {
    try {
      const appWindow = getCurrentWindow();
      const nextFullscreen = !isFullscreen;
      await appWindow.setFullscreen(nextFullscreen);
      setFullscreen(nextFullscreen);
    } catch (err) {
      console.error('Failed to toggle fullscreen:', err);
    }
  };

  const handleDelete = async () => {
    await deleteCurrentImage({ currentImagePath, currentIndex, removeImage });
  };

  const handleCopy = async () => {
    await copyCurrentImage(currentImagePath);
  };

  const handleReveal = async () => {
    await revealCurrentImage(currentImagePath);
  };

  const handleToggleFavorite = async () => {
    if (!currentImagePath) {
      return;
    }
    await toggleFavorite(currentImagePath);
  };

  const handleSetRating = async (rating: number) => {
    if (!currentImagePath) {
      return;
    }
    await setRating(currentImagePath, rating);
  };

  const handleSaveCroppedCopy = async () => {
    if (!currentImagePath || !cropRect) {
      return;
    }

    const activeImage = document.querySelector('.image-canvas img') as HTMLImageElement | null;
    const imageWidth = activeImage?.naturalWidth ?? 0;
    const imageHeight = activeImage?.naturalHeight ?? 0;

    if (imageWidth <= 0 || imageHeight <= 0) {
      await message('Unable to determine image dimensions for crop export.', {
        title: 'Error',
        kind: 'error',
      });
      return;
    }

    const pixelCropRect = normalizedToIntegerPixelRect(cropRect, imageWidth, imageHeight);
    const originalName = getFileName(currentImagePath);
    const dotIndex = originalName.lastIndexOf('.');
    const baseName = dotIndex >= 0 ? originalName.slice(0, dotIndex) : originalName;
    const extension = dotIndex >= 0 ? originalName.slice(dotIndex) : '';
    const outputPath = await save({
      defaultPath: currentImagePath.replace(originalName, `${baseName}-cropped${extension}`),
    });

    if (!outputPath) {
      return;
    }

    try {
      await saveCroppedCopy(currentImagePath, pixelCropRect, outputPath, rotation);
      await message(`Saved cropped copy to:\n${outputPath}`, {
        title: 'Cropped Copy Saved',
        kind: 'info',
      });
    } catch (err) {
      console.error('Failed to save cropped copy:', err);
      await message(`Failed to save cropped copy: ${err}`, {
        title: 'Error',
        kind: 'error',
      });
    }
  };

  const handleOverwriteCrop = async () => {
    if (!currentImagePath || !cropRect) {
      return;
    }

    const activeImage = document.querySelector('.image-canvas img') as HTMLImageElement | null;
    const imageWidth = activeImage?.naturalWidth ?? 0;
    const imageHeight = activeImage?.naturalHeight ?? 0;
    if (imageWidth <= 0 || imageHeight <= 0) {
      await message('Unable to determine image dimensions for crop overwrite.', {
        title: 'Error',
        kind: 'error',
      });
      return;
    }

    const confirmed = await confirm(
      `Overwrite the original image with this crop?\n\n${fileName}\n\nThis modifies the source file.`,
      {
        title: 'Overwrite Cropped Image',
        kind: 'warning',
      }
    );

    if (!confirmed) {
      return;
    }

    try {
      await overwriteWithCrop(
        currentImagePath,
        normalizedToIntegerPixelRect(cropRect, imageWidth, imageHeight),
        rotation
      );
      invalidateImageAsset(currentImagePath);
      invalidateThumbnail(currentImagePath);
      clearPendingEdits(currentImagePath);
      useViewerStore.setState({ cacheBuster: Date.now() });
      setExifRefreshToken((value) => value + 1);
      await message('Original image updated with the cropped selection.', {
        title: 'Crop Saved',
        kind: 'info',
      });
    } catch (err) {
      console.error('Failed to overwrite cropped image:', err);
      await message(`Failed to overwrite cropped image: ${err}`, {
        title: 'Error',
        kind: 'error',
      });
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
      <div className="top-bar" role="toolbar" aria-label="Image information">
        <div className="top-bar-left">
          <span className="file-name" title={fileName}>
            {fileName}
          </span>
          {images.length > 0 && (
            <span className="image-counter">
              {currentIndex + 1} / {images.length}
              {isFolderScanning && ' …'}
            </span>
          )}
          {(isFavorite || currentRating > 0) && (
            <span className="image-counter">
              {isFavorite ? '★' : '☆'} {currentRating}/5
            </span>
          )}
          {hasPendingEdits && <span className="image-counter">Unsaved edits</span>}
        </div>

        <div className="top-bar-right">
          <div className="top-bar-group" aria-label="Navigation actions">
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={onGoHome}
              title="Back to landing page"
              aria-label="Back to landing page"
              id="btn-home"
            >
              <span className="top-bar-btn-icon">⌂</span>
              <span className="top-bar-btn-label">Home</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={onOpenFile}
              title="Open file (Ctrl+O)"
              aria-label="Open file"
              id="btn-open-file"
            >
              <span className="top-bar-btn-icon">📄</span>
              <span className="top-bar-btn-label">Open</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={onOpenFolder}
              title="Open folder"
              aria-label="Open folder"
              id="btn-open-folder"
            >
              <span className="top-bar-btn-icon">📁</span>
              <span className="top-bar-btn-label">Folder</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={onRefreshFolder}
              title="Refresh folder (Ctrl+R / F6)"
              aria-label="Refresh folder"
              id="btn-refresh-folder"
              disabled={!folderPath}
            >
              <span className="top-bar-btn-icon">↻</span>
              <span className="top-bar-btn-label">Refresh</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={handleReveal}
              title="Show in folder (Ctrl+Shift+O)"
              aria-label="Show in folder"
              id="btn-reveal"
            >
              <span className="top-bar-btn-icon">📂</span>
              <span className="top-bar-btn-label">Reveal</span>
            </button>
          </div>

          <div className="top-bar-separator" aria-hidden="true" />

          <div className="top-bar-group" aria-label="File actions">
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={handleCopy}
              title="Copy to Clipboard"
              aria-label="Copy to Clipboard"
              id="btn-copy"
            >
              <span className="top-bar-btn-icon">📋</span>
              <span className="top-bar-btn-label">Copy</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={handleDelete}
              title="Move to Recycle Bin"
              aria-label="Delete image"
              id="btn-delete"
            >
              <span className="top-bar-btn-icon">🗑</span>
              <span className="top-bar-btn-label">Delete</span>
            </button>
          </div>

          <div className="top-bar-separator" aria-hidden="true" />

          <div className="top-bar-group" aria-label="Curation actions">
            <button
              className={`top-bar-btn top-bar-btn--labeled ${isFavorite ? 'active' : ''}`}
              onClick={() => void handleToggleFavorite()}
              title="Toggle favorite (F)"
              aria-label="Toggle favorite"
              id="btn-favorite"
            >
              <span className="top-bar-btn-icon">{isFavorite ? '★' : '☆'}</span>
              <span className="top-bar-btn-label">Favorite</span>
            </button>
          </div>

          <div className="top-bar-separator" aria-hidden="true" />

          <div className="top-bar-group" aria-label="View actions">
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={toggleFullscreen}
              title="Toggle fullscreen (F11)"
              aria-label="Toggle fullscreen"
              id="btn-fullscreen"
            >
              <span className="top-bar-btn-icon">{isFullscreen ? '🗗' : '⛶'}</span>
              <span className="top-bar-btn-label">Full</span>
            </button>
            <button
              className={`top-bar-btn top-bar-btn--labeled ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode(viewMode === 'viewer' ? 'grid' : 'viewer')}
              title="Grid view (G)"
              aria-label="Toggle grid view"
              id="btn-grid"
            >
              <span className="top-bar-btn-icon">▦</span>
              <span className="top-bar-btn-label">Grid</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={openSecondaryWindow}
              title="Open Projector Mode (Secondary Window)"
              aria-label="Open projector mode"
              id="btn-projector"
            >
              <span className="top-bar-btn-icon">📽</span>
              <span className="top-bar-btn-label">Projector</span>
            </button>
            <button
              className={`top-bar-btn top-bar-btn--labeled ${showExif ? 'active' : ''}`}
              onClick={() => setShowExif((value) => !value)}
              title="Image info (I)"
              aria-label="Toggle image info panel"
              id="btn-info"
            >
              <span className="top-bar-btn-icon">ℹ</span>
              <span className="top-bar-btn-label">Info</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled"
              onClick={() => setShowSettings(true)}
              title="Settings (Ctrl+,)"
              aria-label="Open settings"
              id="btn-settings"
            >
              <span className="top-bar-btn-icon">⚙</span>
              <span className="top-bar-btn-label">Settings</span>
            </button>
            <button
              className={`top-bar-btn top-bar-btn--labeled ${isCropMode || pendingCropPreview ? 'active' : ''}`}
              onClick={() => {
                if (isCropMode) {
                  exitCropMode();
                  return;
                }
                if (pendingCropPreview) {
                  clearCropPreview();
                }
                enterCropMode();
              }}
              title={
                cropDisabledByRotation
                  ? 'Crop is unavailable while rotation preview is active'
                  : 'Crop image'
              }
              aria-label="Toggle crop mode"
              id="btn-crop"
              disabled={cropDisabledByRotation}
            >
              <span className="top-bar-btn-icon">✂</span>
              <span className="top-bar-btn-label">Crop</span>
            </button>
          </div>
        </div>
      </div>

      {showExif && currentImagePath && (
        <ExifPanel
          key={`${currentImagePath}:${exifRefreshToken}`}
          filePath={currentImagePath}
          onClose={() => setShowExif(false)}
        />
      )}

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

      {isSlideshowActive && (
        <div className={`slideshow-indicator ${isSlideshowPaused ? 'paused' : ''}`}>
          {isSlideshowPaused ? '⏸ Paused' : '▶ Slideshow'}
        </div>
      )}

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
          className="control-btn"
          onClick={() => useViewerStore.getState().rotateCounterClockwise()}
          title="Rotate counter-clockwise (L)"
          aria-label="Rotate counter-clockwise"
          id="btn-rotate-l"
        >
          ↺
        </button>

        <button
          className="control-btn"
          onClick={() => useViewerStore.getState().rotateClockwise()}
          title="Rotate clockwise (R)"
          aria-label="Rotate clockwise"
          id="btn-rotate-r"
        >
          ↻
        </button>

        {hasPendingEdits && (
          <button
            className="control-btn"
            onClick={() => {
              if (currentImagePath) {
                clearPendingEdits(currentImagePath);
              }
            }}
            title="Reset pending edits"
            aria-label="Reset pending edits"
            id="btn-reset-edits"
          >
            Reset
          </button>
        )}

        {canCommitPendingEdits && (
          <button
            className="control-btn active"
            onClick={() => {
              if (currentImagePath) {
                void commitPendingEdits(currentImagePath);
              }
            }}
            title="Save pending edits"
            aria-label="Save pending edits"
            id="btn-save-edits"
          >
            💾
          </button>
        )}

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

        {(isCropMode || pendingCropPreview) && (
          <>
            <div className="control-divider" />
            <select
              className="crop-aspect-select"
              aria-label="Crop aspect ratio"
              value={cropAspectRatio}
              onChange={(event) =>
                setCropAspectRatio(event.target.value as 'free' | '1:1' | '4:3' | '3:2' | '16:9')
              }
              disabled={!isCropMode}
            >
              <option value="free">Free</option>
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="3:2">3:2</option>
              <option value="16:9">16:9</option>
            </select>
            <button
              className="control-btn"
              onClick={resetCrop}
              title="Reset crop"
              aria-label="Reset crop"
              id="btn-crop-reset"
            >
              Reset
            </button>
            {isCropMode ? (
              <button
                className="control-btn active"
                onClick={applyCropPreview}
                title="Preview crop (Enter)"
                aria-label="Preview crop"
                id="btn-crop-preview"
                disabled={!canPreviewCrop}
              >
                Preview
              </button>
            ) : (
              <button
                className="control-btn"
                onClick={clearCropPreview}
                title="Clear crop preview"
                aria-label="Clear crop preview"
                id="btn-crop-clear-preview"
              >
                Clear
              </button>
            )}
            {isCropMode && (
              <button
                className="control-btn active"
                onClick={() => void handleSaveCroppedCopy()}
                title="Save cropped copy"
                aria-label="Save cropped copy"
                id="btn-crop-save-copy"
                disabled={!cropRect}
              >
                Save Copy
              </button>
            )}
            {isCropMode && (
              <button
                className="control-btn"
                onClick={() => void handleOverwriteCrop()}
                title="Overwrite original with crop"
                aria-label="Overwrite original with crop"
                id="btn-crop-overwrite"
                disabled={!cropRect}
              >
                Overwrite
              </button>
            )}
          </>
        )}

        <div className="control-divider" />

        <div className="rating-controls" role="group" aria-label="Image rating">
          {[0, 1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              className={`control-btn rating-btn ${currentRating === value ? 'active' : ''}`}
              onClick={() => void handleSetRating(value)}
              title={value === 0 ? 'Clear rating (Alt+0)' : `Set rating ${value} (Alt+${value})`}
              aria-label={value === 0 ? 'Clear rating' : `Set rating ${value}`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

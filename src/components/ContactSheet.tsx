import { useEffect, useMemo, useRef, useState, type MouseEvent, type UIEvent } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';
import {
  evictThumbnailsExcept,
  getCachedThumbnail,
  invalidateThumbnail,
  preloadThumbnails,
} from '../services/thumbnailCache';
import { useThumbnailRefreshSignal } from '../hooks/useThumbnailRefreshSignal';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { selectRangePaths, toggleSelectionPath } from '../services/contactSheetSelection';
import { showTransferResultMessage, transferImagesToDestination } from '../services/viewerActions';
import type { QuickDestination } from '../types/settings';

const GRID_ITEM_SIZE = 140;
const GRID_GAP = 20;
const GRID_LABEL_HEIGHT = 20;
const GRID_ROW_HEIGHT = GRID_ITEM_SIZE + GRID_GAP + GRID_LABEL_HEIGHT;
const GRID_OVERSCAN_ROWS = 3;
const MAX_CACHED_THUMBNAILS = 1000;

interface ContactSheetProps {
  onGoHome: () => void;
}

/**
 * A full-screen grid view of all images in the current folder.
 * Windowed rendering keeps large folders responsive.
 */
export function ContactSheet({ onGoHome }: ContactSheetProps) {
  const { images, currentIndex, setCurrentIndex, setViewMode } = useViewerStore();
  const curationByPath = useCurationStore((state) => state.curationByPath);
  const quickDestinations = useSettingsStore((state) => state.settings.quickDestinations);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [columns, setColumns] = useState(1);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const { handleThumbnailLoaded, isThumbnailConsumerActive } = useThumbnailRefreshSignal();

  const totalRows = Math.ceil(images.length / columns);
  const activeRow = currentIndex >= 0 ? Math.floor(currentIndex / columns) : 0;
  const visibleRange = useMemo(() => {
    const firstRow = Math.max(0, Math.floor(scrollTop / GRID_ROW_HEIGHT) - GRID_OVERSCAN_ROWS);
    const rowCount = Math.ceil(viewportHeight / GRID_ROW_HEIGHT) + GRID_OVERSCAN_ROWS * 2;
    const lastRow = Math.min(totalRows, firstRow + rowCount);

    return {
      startIndex: firstRow * columns,
      endIndex: Math.min(images.length, lastRow * columns),
      topHeight: firstRow * GRID_ROW_HEIGHT,
      bottomHeight: Math.max(0, (totalRows - lastRow) * GRID_ROW_HEIGHT),
    };
  }, [columns, images.length, scrollTop, totalRows, viewportHeight]);

  const visibleImages = useMemo(
    () => images.slice(visibleRange.startIndex, visibleRange.endIndex),
    [images, visibleRange.endIndex, visibleRange.startIndex]
  );

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const updateMetrics = () => {
      const availableWidth = Math.min(1400, content.clientWidth);
      setColumns(
        Math.max(1, Math.floor((availableWidth + GRID_GAP) / (GRID_ITEM_SIZE + GRID_GAP)))
      );
      setViewportHeight(content.clientHeight);
      setScrollTop(content.scrollTop);
    };

    updateMetrics();
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(content);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contentRef.current || currentIndex < 0) return;

    const targetTop = activeRow * GRID_ROW_HEIGHT;
    const targetBottom = targetTop + GRID_ROW_HEIGHT;
    const viewTop = contentRef.current.scrollTop;
    const viewBottom = viewTop + contentRef.current.clientHeight;

    if (targetTop < viewTop || targetBottom > viewBottom) {
      contentRef.current.scrollTo({
        top: Math.max(0, targetTop - GRID_ROW_HEIGHT),
        behavior: 'auto',
      });
    }
  }, [activeRow, currentIndex]);

  useEffect(() => {
    preloadThumbnails(
      visibleImages.map((image) => ({
        path: image.path,
        sizeBytes: image.size_bytes,
        modifiedAt: image.modified_at,
      })),
      {
        concurrency: 6,
        onLoaded: handleThumbnailLoaded,
        isActive: isThumbnailConsumerActive,
      }
    );

    const keepStart = Math.max(0, visibleRange.startIndex - columns * GRID_OVERSCAN_ROWS * 4);
    const keepEnd = Math.min(
      images.length,
      visibleRange.endIndex + columns * GRID_OVERSCAN_ROWS * 4
    );
    const keepPaths = new Set(images.slice(keepStart, keepEnd).map((image) => image.path));
    evictThumbnailsExcept(keepPaths, MAX_CACHED_THUMBNAILS);
  }, [
    columns,
    handleThumbnailLoaded,
    images,
    isThumbnailConsumerActive,
    visibleImages,
    visibleRange.endIndex,
    visibleRange.startIndex,
  ]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const validPaths = new Set(images.map((image) => image.path));
    setSelectedPaths((current) => current.filter((path) => validPaths.has(path)));
  }, [images]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    if (scrollRafRef.current !== null) return;

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop(nextScrollTop);
    });
  };

  const handleSelect = (index: number) => {
    setCurrentIndex(index);
    setViewMode('viewer');
  };

  const handleGridItemClick = (event: MouseEvent<HTMLDivElement>, index: number, path: string) => {
    if (event.shiftKey && lastSelectedIndex !== null) {
      setSelectedPaths((current) => selectRangePaths(images, lastSelectedIndex, index, current));
      setLastSelectedIndex(index);
      setCurrentIndex(index);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedPaths((current) => toggleSelectionPath(current, path));
      setLastSelectedIndex(index);
      setCurrentIndex(index);
      return;
    }

    setSelectedPaths([path]);
    setLastSelectedIndex(index);
    handleSelect(index);
  };

  const removeMovedImages = (paths: string[]) => {
    const state = useViewerStore.getState();
    const indexByPath = new Map(state.images.map((image, index) => [image.path, index]));
    const indices = paths
      .map((path) => {
        invalidateThumbnail(path);
        invalidateImageAsset(path);
        return indexByPath.get(path);
      })
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => b - a);

    for (const index of indices) {
      useViewerStore.getState().removeImage(index);
    }
  };

  const handleBulkTransfer = async (destination: QuickDestination, mode: 'copy' | 'move') => {
    const targetPaths =
      selectedPaths.length > 0
        ? selectedPaths
        : currentIndex >= 0
          ? [images[currentIndex].path]
          : [];
    if (targetPaths.length === 0) {
      return;
    }

    const result = await transferImagesToDestination(targetPaths, destination, mode);
    if (mode === 'move') {
      removeMovedImages(result.successes.map((success) => success.sourcePath));
      setSelectedPaths((current) =>
        current.filter((path) => !result.successes.some((success) => success.sourcePath === path))
      );
    }
    await showTransferResultMessage(result, destination, mode);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        setViewMode('viewer');
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCurrentIndex(Math.min(images.length - 1, currentIndex + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrentIndex(Math.max(0, currentIndex - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCurrentIndex(Math.min(images.length - 1, currentIndex + columns));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCurrentIndex(Math.max(0, currentIndex - columns));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCurrentIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setCurrentIndex(images.length - 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [columns, currentIndex, images.length, setCurrentIndex, setViewMode]);

  return (
    <div className="contact-sheet-overlay">
      <div className="contact-sheet-header">
        <div className="header-left">
          <h2>Contact Sheet</h2>
          <span className="image-count">{images.length} images</span>
          {selectedPaths.length > 0 && (
            <span className="image-count">{selectedPaths.length} selected</span>
          )}
        </div>
        <div className="header-actions">
          <details className="header-menu">
            <summary
              className="header-btn"
              aria-label="Copy selected images"
              title={
                quickDestinations.length > 0
                  ? 'Copy selected images'
                  : 'Add quick destinations in settings'
              }
            >
              Copy To
            </summary>
            <div className="header-menu-panel">
              {quickDestinations.length === 0 ? (
                <span className="header-menu-empty">No destinations configured</span>
              ) : (
                quickDestinations.map((destination) => (
                  <button
                    key={destination.id}
                    className="header-menu-item"
                    onClick={() => void handleBulkTransfer(destination, 'copy')}
                  >
                    {destination.label}
                  </button>
                ))
              )}
            </div>
          </details>
          <details className="header-menu">
            <summary
              className="header-btn"
              aria-label="Move selected images"
              title={
                quickDestinations.length > 0
                  ? 'Move selected images'
                  : 'Add quick destinations in settings'
              }
            >
              Move To
            </summary>
            <div className="header-menu-panel">
              {quickDestinations.length === 0 ? (
                <span className="header-menu-empty">No destinations configured</span>
              ) : (
                quickDestinations.map((destination) => (
                  <button
                    key={destination.id}
                    className="header-menu-item"
                    onClick={() => void handleBulkTransfer(destination, 'move')}
                  >
                    {destination.label}
                  </button>
                ))
              )}
            </div>
          </details>
          <button
            className="header-btn"
            onClick={onGoHome}
            title="Back to landing page"
            aria-label="Back to landing page"
            id="btn-home-grid"
          >
            Home
          </button>
          <button
            className="close-btn"
            onClick={() => setViewMode('viewer')}
            title="Close Grid View (Esc)"
            aria-label="Close grid view"
          >
            x
          </button>
        </div>
      </div>
      <div className="contact-sheet-content" ref={contentRef} onScroll={handleScroll}>
        <div
          className="contact-sheet-grid"
          style={{
            gridTemplateColumns: `repeat(${columns}, ${GRID_ITEM_SIZE}px)`,
          }}
        >
          {visibleRange.topHeight > 0 && (
            <div className="grid-spacer" style={{ height: visibleRange.topHeight }} />
          )}
          {visibleImages.map((image, visibleIndex) => {
            const index = visibleRange.startIndex + visibleIndex;
            const isActive = index === currentIndex;
            const url = getCachedThumbnail({
              path: image.path,
              sizeBytes: image.size_bytes,
              modifiedAt: image.modified_at,
            });
            const curation = curationByPath[image.path];
            const isFavorite = Boolean(curation?.favorite);
            const rating = curation?.rating ?? 0;

            return (
              <div
                key={image.path}
                className={`grid-item ${isActive ? 'active' : ''} ${selectedPaths.includes(image.path) ? 'selected' : ''}`}
                onClick={(event) => handleGridItemClick(event, index, image.path)}
                title={image.file_name}
              >
                <div className="grid-thumbnail-wrapper">
                  {(isFavorite || rating > 0) && (
                    <div className="grid-curation-badges" aria-hidden="true">
                      {isFavorite && <span className="grid-curation-badge favorite">★</span>}
                      {rating > 0 && <span className="grid-curation-badge rating">{rating}</span>}
                    </div>
                  )}
                  {url ? (
                    <img src={url} alt="" draggable={false} />
                  ) : (
                    <div className="grid-placeholder" />
                  )}
                </div>
                <div className="grid-label" title={image.file_name}>
                  {image.file_name}
                </div>
              </div>
            );
          })}
          {visibleRange.bottomHeight > 0 && (
            <div className="grid-spacer" style={{ height: visibleRange.bottomHeight }} />
          )}
        </div>
      </div>
    </div>
  );
}

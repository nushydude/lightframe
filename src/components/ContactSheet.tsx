import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { getThumbnail } from '../services/tauriCommands';

const GRID_ITEM_SIZE = 140;
const GRID_GAP = 20;
const GRID_LABEL_HEIGHT = 20;
const GRID_ROW_HEIGHT = GRID_ITEM_SIZE + GRID_GAP + GRID_LABEL_HEIGHT;
const GRID_OVERSCAN_ROWS = 3;
const MAX_CACHED_THUMBNAILS = 900;
const MAX_THUMBNAIL_REQUESTS = 6;

interface ContactSheetProps {
  onGoHome: () => void;
}

/**
 * A full-screen grid view of all images in the current folder.
 * Windowed rendering keeps large folders responsive.
 */
export function ContactSheet({ onGoHome }: ContactSheetProps) {
  const { images, currentIndex, setCurrentIndex, setViewMode } = useViewerStore();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [columns, setColumns] = useState(1);
  const [, setThumbnailVersion] = useState(0);

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const cacheRef = useRef<Record<string, string>>({});
  const queuedRef = useRef<string[]>([]);
  const queuedPathsRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const batchRef = useRef<Record<string, string>>({});
  const batchRafRef = useRef<number | null>(null);

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

  const flushThumbnailBatch = useCallback(() => {
    batchRafRef.current = null;
    const batch = batchRef.current;
    batchRef.current = {};
    if (Object.keys(batch).length === 0) return;

    setThumbnailVersion((version) => version + 1);
  }, []);

  const scheduleThumbnailFlush = useCallback(() => {
    if (batchRafRef.current !== null) return;
    batchRafRef.current = window.requestAnimationFrame(flushThumbnailBatch);
  }, [flushThumbnailBatch]);

  const pumpThumbnailQueue = useCallback(() => {
    while (
      inFlightRef.current.size < MAX_THUMBNAIL_REQUESTS &&
      queuedRef.current.length > 0
    ) {
      const path = queuedRef.current.shift();
      if (!path) return;

      queuedPathsRef.current.delete(path);
      if (cacheRef.current[path] || inFlightRef.current.has(path)) continue;

      inFlightRef.current.add(path);
      getThumbnail(path)
        .then((base64) => {
          cacheRef.current[path] = base64;
          batchRef.current[path] = base64;
          scheduleThumbnailFlush();
        })
        .catch(() => {
          // Ignore thumbnail failures to keep scrolling quiet and responsive.
        })
        .finally(() => {
          inFlightRef.current.delete(path);
          pumpThumbnailQueue();
        });
    }
  }, [scheduleThumbnailFlush]);

  const queueThumbnail = useCallback((path: string) => {
    if (
      cacheRef.current[path] ||
      queuedPathsRef.current.has(path) ||
      inFlightRef.current.has(path)
    ) {
      return;
    }

    queuedPathsRef.current.add(path);
    queuedRef.current.push(path);
    pumpThumbnailQueue();
  }, [pumpThumbnailQueue]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const updateMetrics = () => {
      const availableWidth = Math.min(1400, content.clientWidth);
      setColumns(Math.max(1, Math.floor((availableWidth + GRID_GAP) / (GRID_ITEM_SIZE + GRID_GAP))));
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
    visibleImages.forEach((image) => queueThumbnail(image.path));

    if (Object.keys(cacheRef.current).length > MAX_CACHED_THUMBNAILS) {
      const keepStart = Math.max(0, visibleRange.startIndex - columns * GRID_OVERSCAN_ROWS * 4);
      const keepEnd = Math.min(
        images.length,
        visibleRange.endIndex + columns * GRID_OVERSCAN_ROWS * 4
      );
      const keepPaths = new Set(images.slice(keepStart, keepEnd).map((image) => image.path));
      const nextCache: Record<string, string> = {};

      keepPaths.forEach((path) => {
        if (cacheRef.current[path]) {
          nextCache[path] = cacheRef.current[path];
        }
      });

      cacheRef.current = nextCache;
      setThumbnailVersion((version) => version + 1);
    }
  }, [columns, images, queueThumbnail, visibleImages, visibleRange.endIndex, visibleRange.startIndex]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
      if (batchRafRef.current !== null) {
        window.cancelAnimationFrame(batchRafRef.current);
      }
    };
  }, []);

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
        </div>
        <div className="header-actions">
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
            const url = cacheRef.current[image.path];

            return (
              <div
                key={image.path}
                className={`grid-item ${isActive ? 'active' : ''}`}
                onClick={() => handleSelect(index)}
                title={image.file_name}
              >
                <div className="grid-thumbnail-wrapper">
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { getThumbnail } from '../services/tauriCommands';

const THUMBNAIL_ITEM_WIDTH = 78;
const THUMBNAIL_WINDOW_RADIUS = 35;
const MAX_THUMBNAIL_REQUESTS = 4;

/**
 * A high-performance horizontal strip of thumbnails for quick navigation.
 * Renders a moving window around the active image instead of the whole folder.
 */
export function ThumbnailStrip() {
  const { images, currentIndex, setCurrentIndex } = useViewerStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<Record<string, string>>({});
  const queuedRef = useRef<string[]>([]);
  const queuedPathsRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const batchRef = useRef<Record<string, string>>({});
  const batchRafRef = useRef<number | null>(null);

  const [, setThumbnailVersion] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  const startIndex = Math.max(0, currentIndex - THUMBNAIL_WINDOW_RADIUS);
  const endIndex = Math.min(images.length, currentIndex + THUMBNAIL_WINDOW_RADIUS + 1);
  const visibleImages = useMemo(
    () => images.slice(startIndex, endIndex),
    [endIndex, images, startIndex]
  );
  const visibleImageKey = useMemo(
    () => visibleImages.map((image) => image.path).join('|'),
    [visibleImages]
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
        .catch((err) => {
          console.error('Thumbnail failed:', err);
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
    visibleImages.forEach((image) => queueThumbnail(image.path));

    if (Object.keys(cacheRef.current).length > 160) {
      const keepPaths = new Set(visibleImages.map((image) => image.path));
      const nextCache: Record<string, string> = {};
      keepPaths.forEach((path) => {
        if (cacheRef.current[path]) {
          nextCache[path] = cacheRef.current[path];
        }
      });
      cacheRef.current = nextCache;
      setThumbnailVersion((version) => version + 1);
    }
  }, [queueThumbnail, visibleImages]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const activeItem = activeItemRef.current;
    if (!container || !activeItem) return;

    const targetLeft = activeItem.offsetLeft - (container.clientWidth - activeItem.offsetWidth) / 2;
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const nextScrollLeft = Math.max(0, Math.min(targetLeft, maxScrollLeft));

    container.scrollTo({
      left: nextScrollLeft,
      behavior: 'auto',
    });
  }, [containerWidth, currentIndex, endIndex, startIndex, visibleImageKey]);

  useEffect(() => {
    return () => {
      if (batchRafRef.current !== null) {
        window.cancelAnimationFrame(batchRafRef.current);
      }
    };
  }, []);

  if (images.length <= 1) return null;

  return (
    <div className="thumbnail-strip-container" ref={containerRef}>
      <div className="thumbnail-strip">
        {startIndex > 0 && (
          <div
            className="thumbnail-spacer"
            style={{ width: startIndex * THUMBNAIL_ITEM_WIDTH }}
          />
        )}
        {visibleImages.map((image, visibleIndex) => {
          const index = startIndex + visibleIndex;
          const isActive = index === currentIndex;
          const url = cacheRef.current[image.path];

          return (
            <div
              key={image.path}
              ref={isActive ? activeItemRef : null}
              className={`thumbnail-item ${isActive ? 'active' : ''}`}
              onClick={() => setCurrentIndex(index)}
              title={image.file_name}
            >
              {url ? (
                <img
                  src={url}
                  alt=""
                  draggable={false}
                />
              ) : (
                <div className="thumbnail-placeholder" />
              )}
            </div>
          );
        })}
        {endIndex < images.length && (
          <div
            className="thumbnail-spacer"
            style={{ width: (images.length - endIndex) * THUMBNAIL_ITEM_WIDTH }}
          />
        )}
      </div>
    </div>
  );
}

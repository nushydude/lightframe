import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '../state/viewerStore';
import {
  evictThumbnailsExcept,
  getCachedThumbnail,
  preloadThumbnails,
} from '../services/thumbnailCache';
import { useThumbnailRefreshSignal } from '../hooks/useThumbnailRefreshSignal';

const THUMBNAIL_ITEM_WIDTH = 78;
const THUMBNAIL_WINDOW_RADIUS = 35;

/**
 * A high-performance horizontal strip of thumbnails for quick navigation.
 * Renders a moving window around the active image instead of the whole folder.
 */
export function ThumbnailStrip() {
  const { images, currentIndex, setCurrentIndex } = useViewerStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLDivElement>(null);
  const { handleThumbnailLoaded, isThumbnailConsumerActive } = useThumbnailRefreshSignal();

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

  useEffect(() => {
    preloadThumbnails(
      visibleImages.map((image) => ({
        path: image.path,
        sizeBytes: image.size_bytes,
        modifiedAt: image.modified_at,
      })),
      {
        concurrency: 4,
        onLoaded: handleThumbnailLoaded,
        isActive: isThumbnailConsumerActive,
      }
    );
    const visiblePaths = visibleImages.map((image) => image.path);
    evictThumbnailsExcept(new Set(visiblePaths));
  }, [handleThumbnailLoaded, isThumbnailConsumerActive, visibleImages]);

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

  if (images.length <= 1) return null;

  return (
    <div className="thumbnail-strip-container" ref={containerRef}>
      <div className="thumbnail-strip">
        {startIndex > 0 && (
          <div className="thumbnail-spacer" style={{ width: startIndex * THUMBNAIL_ITEM_WIDTH }} />
        )}
        {visibleImages.map((image, visibleIndex) => {
          const index = startIndex + visibleIndex;
          const isActive = index === currentIndex;
          const url = getCachedThumbnail({
            path: image.path,
            sizeBytes: image.size_bytes,
            modifiedAt: image.modified_at,
          });

          return (
            <div
              key={image.path}
              ref={isActive ? activeItemRef : null}
              className={`thumbnail-item ${isActive ? 'active' : ''}`}
              onClick={() => setCurrentIndex(index)}
              title={image.file_name}
            >
              {url ? (
                <img src={url} alt="" draggable={false} />
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

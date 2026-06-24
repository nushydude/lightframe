import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
  type WheelEvent,
} from 'react';
import { useViewerStore } from '../state/viewerStore';
import {
  evictThumbnailsExcept,
  getCachedThumbnail,
  preloadThumbnails,
} from '../services/thumbnailCache';
import { useThumbnailRefreshSignal } from '../hooks/useThumbnailRefreshSignal';

const THUMBNAIL_ITEM_SIZE = 70;
const THUMBNAIL_ITEM_GAP = 8;
const THUMBNAIL_ITEM_PITCH = THUMBNAIL_ITEM_SIZE + THUMBNAIL_ITEM_GAP;
const THUMBNAIL_STRIP_PADDING = 12;
const THUMBNAIL_OVERSCAN_ITEMS = 8;
const FALLBACK_VISIBLE_CAPACITY = 12;

type VirtualMetrics = {
  containerWidth: number;
  startIndex: number;
  endIndex: number;
};

function getTargetScrollLeft(currentIndex: number, containerWidth: number, maxScrollLeft: number) {
  if (currentIndex < 0) return 0;

  const viewportWidth =
    containerWidth > 0 ? containerWidth : FALLBACK_VISIBLE_CAPACITY * THUMBNAIL_ITEM_PITCH;
  const itemLeft = THUMBNAIL_STRIP_PADDING + currentIndex * THUMBNAIL_ITEM_PITCH;
  const targetLeft = itemLeft - (viewportWidth - THUMBNAIL_ITEM_SIZE) / 2;
  return Math.max(0, Math.min(targetLeft, maxScrollLeft));
}

function getStripWidth(containerWidth: number, imageCount: number): number {
  return Math.max(
    containerWidth,
    THUMBNAIL_STRIP_PADDING * 2 +
      Math.max(0, imageCount * THUMBNAIL_ITEM_PITCH - THUMBNAIL_ITEM_GAP)
  );
}

function getVirtualMetrics(
  scrollLeft: number,
  containerWidth: number,
  imageCount: number
): VirtualMetrics {
  const visibleCapacity =
    containerWidth > 0
      ? Math.ceil(containerWidth / THUMBNAIL_ITEM_PITCH)
      : FALLBACK_VISIBLE_CAPACITY;
  const startIndex = Math.max(
    0,
    Math.floor(Math.max(0, scrollLeft - THUMBNAIL_STRIP_PADDING) / THUMBNAIL_ITEM_PITCH) -
      THUMBNAIL_OVERSCAN_ITEMS
  );

  return {
    containerWidth,
    startIndex,
    endIndex: Math.min(imageCount, startIndex + visibleCapacity + THUMBNAIL_OVERSCAN_ITEMS * 2),
  };
}

function virtualMetricsEqual(left: VirtualMetrics, right: VirtualMetrics) {
  return (
    left.containerWidth === right.containerWidth &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}

function getCurrentIndexWindow(
  currentIndex: number,
  containerWidth: number,
  imageCount: number
): { scrollLeft: number; metrics: VirtualMetrics } {
  const maxScrollLeft = Math.max(0, getStripWidth(containerWidth, imageCount) - containerWidth);
  const scrollLeft = getTargetScrollLeft(currentIndex, containerWidth, maxScrollLeft);

  return {
    scrollLeft,
    metrics: getVirtualMetrics(scrollLeft, containerWidth, imageCount),
  };
}

/**
 * A high-performance horizontal strip of thumbnails for quick navigation.
 * Renders the scrolled viewport instead of the whole folder.
 */
export function ThumbnailStrip() {
  const { images, currentIndex, setCurrentIndex } = useViewerStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const initialWindow = getCurrentIndexWindow(currentIndex, 0, images.length);
  const pendingScrollLeftRef = useRef(initialWindow.scrollLeft);
  const virtualMetricsRef = useRef(initialWindow.metrics);
  const metricsImagesRef = useRef(images);
  const hasSyncedInitialScrollRef = useRef(false);
  const { handleThumbnailLoaded, isThumbnailConsumerActive } = useThumbnailRefreshSignal();

  const [virtualMetrics, setVirtualMetrics] = useState<VirtualMetrics>(virtualMetricsRef.current);
  const renderMetrics =
    metricsImagesRef.current === images
      ? virtualMetrics
      : getCurrentIndexWindow(currentIndex, virtualMetrics.containerWidth, images.length).metrics;
  const { containerWidth, startIndex, endIndex } = renderMetrics;
  const visibleImages = useMemo(
    () => images.slice(startIndex, endIndex),
    [endIndex, images, startIndex]
  );

  const commitVirtualMetrics = useCallback(
    (nextScrollLeft: number, nextContainerWidth = virtualMetricsRef.current.containerWidth) => {
      const nextMetrics = getVirtualMetrics(nextScrollLeft, nextContainerWidth, images.length);
      metricsImagesRef.current = images;
      if (virtualMetricsEqual(virtualMetricsRef.current, nextMetrics)) {
        return;
      }

      virtualMetricsRef.current = nextMetrics;
      setVirtualMetrics(nextMetrics);
    },
    [images]
  );

  const scheduleVirtualMetricsUpdate = useCallback(
    (nextScrollLeft: number, nextContainerWidth = virtualMetricsRef.current.containerWidth) => {
      pendingScrollLeftRef.current = nextScrollLeft;
      if (scrollRafRef.current !== null) return;

      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = null;
        commitVirtualMetrics(pendingScrollLeftRef.current, nextContainerWidth);
      });
    },
    [commitVirtualMetrics]
  );

  const syncScrollToCurrentIndex = useCallback(
    (container: HTMLDivElement, nextContainerWidth = container.clientWidth) => {
      const { scrollLeft: nextScrollLeft } = getCurrentIndexWindow(
        currentIndex,
        nextContainerWidth,
        images.length
      );

      container.scrollTo({
        left: nextScrollLeft,
        behavior: 'auto',
      });
      pendingScrollLeftRef.current = nextScrollLeft;
      commitVirtualMetrics(nextScrollLeft, nextContainerWidth);
    },
    [commitVirtualMetrics, currentIndex, images.length]
  );

  useLayoutEffect(() => {
    if (metricsImagesRef.current === images) return;

    const container = containerRef.current;
    const nextContainerWidth = container?.clientWidth ?? virtualMetricsRef.current.containerWidth;
    const { scrollLeft: nextScrollLeft, metrics: nextMetrics } = getCurrentIndexWindow(
      currentIndex,
      nextContainerWidth,
      images.length
    );

    if (container) {
      container.scrollTo({
        left: nextScrollLeft,
        behavior: 'auto',
      });
    }

    pendingScrollLeftRef.current = nextScrollLeft;
    metricsImagesRef.current = images;
    virtualMetricsRef.current = nextMetrics;
    setVirtualMetrics((currentMetrics) =>
      virtualMetricsEqual(currentMetrics, nextMetrics) ? currentMetrics : nextMetrics
    );
  }, [currentIndex, images]);

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

    const updateMetrics = () => {
      if (!hasSyncedInitialScrollRef.current) {
        hasSyncedInitialScrollRef.current = true;
        syncScrollToCurrentIndex(container);
        return;
      }

      pendingScrollLeftRef.current = container.scrollLeft;
      commitVirtualMetrics(container.scrollLeft, container.clientWidth);
    };
    updateMetrics();

    const observer = new ResizeObserver(updateMetrics);
    observer.observe(container);

    return () => observer.disconnect();
  }, [commitVirtualMetrics, syncScrollToCurrentIndex]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || currentIndex < 0) return;

    syncScrollToCurrentIndex(container);
  }, [containerWidth, currentIndex, syncScrollToCurrentIndex]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    scheduleVirtualMetricsUpdate(event.currentTarget.scrollLeft, event.currentTarget.clientWidth);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    const scrollDelta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (scrollDelta === 0) return;

    event.preventDefault();
    container.scrollLeft += scrollDelta;
    scheduleVirtualMetricsUpdate(container.scrollLeft, container.clientWidth);
  };

  if (images.length <= 1) return null;

  const stripWidth = getStripWidth(containerWidth, images.length);

  return (
    <div
      className="thumbnail-strip-container"
      ref={containerRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
    >
      <div className="thumbnail-strip" style={{ width: stripWidth }}>
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
              className={`thumbnail-item ${isActive ? 'active' : ''}`}
              data-image-path={image.path}
              onClick={() => setCurrentIndex(index)}
              style={{ left: THUMBNAIL_STRIP_PADDING + index * THUMBNAIL_ITEM_PITCH }}
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
      </div>
    </div>
  );
}

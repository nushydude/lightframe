import { useRef, useState, useCallback, useEffect, type CSSProperties } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { convertFileSrc } from '../services/tauriCommands';
import { useZoomPan } from '../hooks/useZoomPan';

/** Main image display canvas with zoom/pan support */
export function ImageCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const { currentImagePath, zoomMode, currentIndex } = useViewerStore();
  const {
    zoomLevel,
    panX,
    panY,
    isDragging,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
  } = useZoomPan(containerRef);

  const [imageSrc, setImageSrc] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);

  // Preload cache
  const preloadCache = useRef<Map<string, string>>(new Map());
  const images = useViewerStore((s) => s.images);

  // Convert file path to asset URL and display
  useEffect(() => {
    if (!currentImagePath) {
      setImageSrc('');
      return;
    }

    let cancelled = false;

    const loadImage = async () => {
      try {
        // Check cache first
        const cached = preloadCache.current.get(currentImagePath);
        if (cached) {
          if (!cancelled) {
            setImageSrc(cached);
            setIsLoading(false);
          }
          return;
        }

        setIsLoading(true);
        const url = await convertFileSrc(currentImagePath);
        if (!cancelled) {
          setImageSrc(url);
          preloadCache.current.set(currentImagePath, url);
        }
      } catch (err) {
        console.error('Failed to load image:', err);
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadImage();

    return () => { 
      cancelled = true;
    };
  }, [currentImagePath]);

  // Preload adjacent images
  useEffect(() => {
    if (images.length === 0 || currentIndex < 0) return;

    // Longer debounce for preload so we don't spam requests when scanning quickly
    const timer = window.setTimeout(() => {
      const preloadIndices = [currentIndex - 1, currentIndex + 1, currentIndex + 2];
      preloadIndices.forEach(async (idx) => {
        if (idx >= 0 && idx < images.length) {
          const path = images[idx].path;
          if (!preloadCache.current.has(path)) {
            try {
              const url = await convertFileSrc(path);
              preloadCache.current.set(path, url);
              // Preload into browser cache
              const img = new Image();
              img.src = url;
            } catch {
              // Ignore preload failures
            }
          }
        }
      });

      // Clean up distant cache entries (keep window of 10)
      if (preloadCache.current.size > 20) {
        const keys = Array.from(preloadCache.current.keys());
        const currentPaths = new Set(
          images
            .slice(Math.max(0, currentIndex - 5), currentIndex + 6)
            .map((img) => img.path)
        );
        keys.forEach((key) => {
          if (!currentPaths.has(key)) {
            preloadCache.current.delete(key);
          }
        });
      }
    }, 150);

    return () => window.clearTimeout(timer);
  }, [currentIndex, images]);

  const handleImageLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  // Compute image transform
  const getImageStyle = useCallback((): CSSProperties => {
    const style: CSSProperties = {};

    if (zoomMode === 'actual') {
      style.transform = `translate(${panX}px, ${panY}px)`;
      style.maxWidth = 'none';
      style.maxHeight = 'none';
    } else if (zoomMode === 'custom') {
      style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
      style.maxWidth = 'none';
      style.maxHeight = 'none';
    } else if (zoomMode === 'fill') {
      style.width = '100%';
      style.height = '100%';
      style.objectFit = 'cover';
    }
    // 'fit' mode uses default CSS

    return style;
  }, [zoomMode, zoomLevel, panX, panY]);

  const containerClasses = [
    'image-canvas',
    isDragging ? 'dragging' : '',
    (zoomMode === 'actual' || zoomMode === 'custom') ? 'zoomable' : '',
  ].filter(Boolean).join(' ');

  if (!currentImagePath) return null;

  return (
    <div
      ref={containerRef}
      className={containerClasses}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {imageSrc && (
        <img
          ref={imgRef}
          src={imageSrc}
          alt=""
          className={`${zoomMode} ${isLoading ? 'loading' : ''}`}
          style={getImageStyle()}
          onLoad={handleImageLoad}
          draggable={false}
        />
      )}
    </div>
  );
}

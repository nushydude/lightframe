import { useRef, useState, useCallback, useEffect, type CSSProperties } from 'react';
import { useViewerStore, type ZoomMode } from '../state/viewerStore';
import {
  getFullAsset,
  getPreviewAsset,
  preloadFullAsset,
  preloadPreviewAsset,
  trimImageAssetCache,
} from '../services/imageAssetCache';
import { getImageMetadata } from '../services/tauriCommands';
import type { ImageMetadata } from '../types/image';
import { useZoomPan } from '../hooks/useZoomPan';
import {
  PREVIEW_MAX_DIMENSION,
  shouldPreloadAdjacentFullResolution,
  shouldLoadFullResolutionImmediately,
  shouldRequestFullResolution,
} from './imagePreviewStrategy';

type ImageCanvasProps = {
  onWheelNext?: () => void;
  onWheelPrev?: () => void;
};

/** Main image display canvas with zoom/pan support */
export function ImageCanvas({ onWheelNext, onWheelPrev }: ImageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isMountedRef = useRef(true);
  const activeRequestIdRef = useRef(0);
  const fullLoadKeyRef = useRef<string | null>(null);
  const metadataByPathRef = useRef(new Map<string, ImageMetadata>());
  const zoomStateRef = useRef<{ zoomMode: ZoomMode; zoomLevel: number }>({
    zoomMode: 'fit',
    zoomLevel: 1,
  });
  const { currentImagePath, zoomMode, currentIndex, rotation, cacheBuster } = useViewerStore();
  const {
    zoomLevel,
    panX,
    panY,
    isDragging,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
  } = useZoomPan(containerRef, { onWheelNext, onWheelPrev });

  const [previewSrc, setPreviewSrc] = useState('');
  const [fullSrc, setFullSrc] = useState('');
  const [isFullResolutionReady, setIsFullResolutionReady] = useState(false);
  const [metadata, setMetadata] = useState<ImageMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const images = useViewerStore((s) => s.images);

  useEffect(() => {
    zoomStateRef.current = { zoomMode, zoomLevel };
  }, [zoomLevel, zoomMode]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      activeRequestIdRef.current += 1;
      fullLoadKeyRef.current = null;
    };
  }, []);

  const ensureFullResolutionLoaded = useCallback((path: string, requestId: number) => {
    const loadKey = `${path}::${requestId}`;
    if (fullLoadKeyRef.current === loadKey) {
      return;
    }
    fullLoadKeyRef.current = loadKey;

    void getFullAsset(path)
      .then((url) => {
        if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
          return;
        }

        const preloader = new Image();
        preloader.onload = () => {
          if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
            return;
          }
          setFullSrc(url);
          setIsFullResolutionReady(true);
          setIsLoading(false);
        };
        preloader.onerror = () => {
          if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
            return;
          }
          setIsLoading(false);
        };
        preloader.src = url;
      })
      .catch((err) => {
        if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
          return;
        }
        console.error('Failed to load full-resolution image:', err);
        setIsLoading(false);
      });
  }, []);

  // Load preview first, then full-resolution pixels on demand.
  useEffect(() => {
    if (!currentImagePath) {
      setPreviewSrc('');
      setFullSrc('');
      setMetadata(null);
      setIsFullResolutionReady(false);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;
    fullLoadKeyRef.current = null;

    setPreviewSrc('');
    setFullSrc('');
    setMetadata(null);
    setIsFullResolutionReady(false);
    setIsLoading(true);

    const loadImage = async () => {
      let imageMetadata: ImageMetadata | null = null;
      try {
        imageMetadata = await getImageMetadata(currentImagePath);
        if (!cancelled && isMountedRef.current && activeRequestIdRef.current === requestId) {
          metadataByPathRef.current.set(currentImagePath, imageMetadata);
          setMetadata(imageMetadata);
        }
      } catch {
        imageMetadata = null;
      }

      try {
        const preview = await getPreviewAsset(currentImagePath, PREVIEW_MAX_DIMENSION);
        if (!cancelled && isMountedRef.current && activeRequestIdRef.current === requestId) {
          setPreviewSrc(preview);
        }
      } catch (err) {
        console.error('Failed to load preview image:', err);
        if (!cancelled && isMountedRef.current && activeRequestIdRef.current === requestId) {
          ensureFullResolutionLoaded(currentImagePath, requestId);
        }
        return;
      }

      const { zoomMode: currentZoomMode, zoomLevel: currentZoomLevel } = zoomStateRef.current;
      if (
        shouldLoadFullResolutionImmediately(
          imageMetadata,
          currentZoomMode,
          currentZoomLevel,
          PREVIEW_MAX_DIMENSION
        )
      ) {
        if (!cancelled && isMountedRef.current && activeRequestIdRef.current === requestId) {
          ensureFullResolutionLoaded(currentImagePath, requestId);
        }
      }
    };

    loadImage();

    return () => {
      cancelled = true;
    };
  }, [currentImagePath, cacheBuster, ensureFullResolutionLoaded]);

  useEffect(() => {
    if (!currentImagePath || isFullResolutionReady) {
      return;
    }

    if (!shouldRequestFullResolution(zoomMode, zoomLevel)) {
      return;
    }

    ensureFullResolutionLoaded(currentImagePath, activeRequestIdRef.current);
  }, [currentImagePath, ensureFullResolutionLoaded, isFullResolutionReady, zoomLevel, zoomMode]);

  // Preload adjacent images
  useEffect(() => {
    if (images.length === 0 || currentIndex < 0) return;

    // Longer debounce for preload so we don't spam requests when scanning quickly
    const timer = window.setTimeout(() => {
      const preloadIndices = [currentIndex - 1, currentIndex + 1, currentIndex + 2];
      preloadIndices.forEach((idx) => {
        if (idx >= 0 && idx < images.length) {
          const path = images[idx].path;
          const metadataForPath = metadataByPathRef.current.get(path) ?? null;
          const preloadPromise = shouldPreloadAdjacentFullResolution(
            metadataForPath,
            PREVIEW_MAX_DIMENSION
          )
            ? preloadFullAsset(path)
            : preloadPreviewAsset(path, PREVIEW_MAX_DIMENSION);

          preloadPromise.catch(() => {
            // Ignore preload failures
          });
        }
      });

      const currentPaths = new Set(
        images
          .slice(Math.max(0, currentIndex - 5), currentIndex + 6)
          .map((img) => img.path)
      );
      trimImageAssetCache(currentPaths, 20);
    }, 150);

    return () => window.clearTimeout(timer);
  }, [currentIndex, images]);

  const handleImageLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  // Compute image transform
  const getImageStyle = useCallback((): CSSProperties => {
    const style: CSSProperties = {};
    const rotationStr = rotation !== 0 ? `rotate(${rotation}deg)` : '';

    if (zoomMode === 'actual') {
      style.transform = `translate(${panX}px, ${panY}px) ${rotationStr}`;
      style.maxWidth = 'none';
      style.maxHeight = 'none';
    } else if (zoomMode === 'custom') {
      style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel}) ${rotationStr}`;
      style.maxWidth = 'none';
      style.maxHeight = 'none';
    } else if (zoomMode === 'fill') {
      style.width = '100%';
      style.height = '100%';
      style.objectFit = 'cover';
      style.transform = rotationStr;
    } else {
      // 'fit' mode
      style.transform = rotationStr;
      
      // If rotated 90 or 270, we need to make sure it still fits
      if (rotation === 90 || rotation === 270) {
        style.maxWidth = '100vh';
        style.maxHeight = '100vw';
      }
    }

    if (
      !isFullResolutionReady &&
      metadata?.width != null &&
      metadata?.height != null &&
      (zoomMode === 'actual' || zoomMode === 'custom')
    ) {
      style.width = `${metadata.width}px`;
      style.height = `${metadata.height}px`;
    }

    return style;
  }, [isFullResolutionReady, metadata?.height, metadata?.width, panX, panY, rotation, zoomLevel, zoomMode]);

  const containerClasses = [
    'image-canvas',
    isDragging ? 'dragging' : '',
    (zoomMode === 'actual' || zoomMode === 'custom') ? 'zoomable' : '',
  ].filter(Boolean).join(' ');

  const imageSrc = isFullResolutionReady ? fullSrc : previewSrc || fullSrc;
  const isImageLoading = isLoading && !previewSrc && !isFullResolutionReady;

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
          className={`${zoomMode} ${isImageLoading ? 'loading' : ''}`}
          style={getImageStyle()}
          onLoad={handleImageLoad}
          draggable={false}
        />
      )}
    </div>
  );
}

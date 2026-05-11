import { useRef, useState, useCallback, useEffect, type CSSProperties } from 'react';
import { useViewerStore, type ZoomMode } from '../state/viewerStore';
import {
  getFullAsset,
  getPreviewAsset,
  preloadFullAsset,
  preloadPreviewAsset,
  trimImageAssetCache,
} from '../services/imageAssetCache';
import {
  NAVIGATION_CACHE_MAX_FULL_ASSET_ENTRIES,
  NAVIGATION_CACHE_NEXT_IMAGES,
  NAVIGATION_CACHE_PRELOAD_DEBOUNCE_MS,
  NAVIGATION_CACHE_PREVIOUS_IMAGES,
} from '../services/navigationCacheConfig';
import { getImageMetadata } from '../services/tauriCommands';
import type { ImageMetadata } from '../types/image';
import { useZoomPan } from '../hooks/useZoomPan';
import {
  PREVIEW_MAX_DIMENSION,
  shouldPreloadAdjacentFullResolution,
  shouldLoadFullResolutionImmediately,
  shouldRequestFullResolution,
} from './imagePreviewStrategy';
import { CropOverlay, getPreviewClipPath } from './CropOverlay';

type ImageCanvasProps = {
  onWheelNext?: () => void;
  onWheelPrev?: () => void;
};

function getHotWindowIndices(currentIndex: number, imageCount: number): number[] {
  const start = Math.max(0, currentIndex - NAVIGATION_CACHE_PREVIOUS_IMAGES);
  const end = Math.min(imageCount - 1, currentIndex + NAVIGATION_CACHE_NEXT_IMAGES);
  const indices: number[] = [];
  for (let index = start; index <= end; index += 1) {
    indices.push(index);
  }
  return indices;
}

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
  const [imageBounds, setImageBounds] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const {
    currentImagePath,
    zoomMode,
    currentIndex,
    rotation,
    cacheBuster,
    loadGeneration,
    isCropMode,
    cropRect,
    pendingCropPreview,
  } =
    useViewerStore();
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

  useEffect(() => {
    const folderPaths = new Set(images.map((image) => image.path));
    trimImageAssetCache(folderPaths, Number.POSITIVE_INFINITY, { pruneMissing: true });
  }, [images]);

  // Preload adjacent images
  useEffect(() => {
    if (images.length === 0 || currentIndex < 0) return;

    let cancelled = false;
    const preloadIndices = getHotWindowIndices(currentIndex, images.length);
    const keepSet = new Set(preloadIndices.map((index) => images[index].path));
    const scheduledLoadGeneration = loadGeneration;
    const canStore = () =>
      !cancelled &&
      isMountedRef.current &&
      useViewerStore.getState().loadGeneration === scheduledLoadGeneration;

    // Debounce preloading so quick scanning does not flood cache requests.
    const timer = window.setTimeout(() => {
      if (!canStore()) {
        return;
      }

      const preloadPromises = preloadIndices
        .map((index) => images[index]?.path)
        .filter((path): path is string => Boolean(path) && path !== currentImagePath)
        .map((path) => {
          const metadataForPath = metadataByPathRef.current.get(path) ?? null;
          const preloadPromise = shouldPreloadAdjacentFullResolution(
            metadataForPath,
            PREVIEW_MAX_DIMENSION
          )
            ? preloadFullAsset(path, { canStore })
            : preloadPreviewAsset(path, PREVIEW_MAX_DIMENSION, { canStore });

          return preloadPromise.catch(() => {
            // Ignore preload failures
          });
        });

      void Promise.allSettled(preloadPromises).then(() => {
        if (!canStore()) {
          return;
        }

        trimImageAssetCache(keepSet, NAVIGATION_CACHE_MAX_FULL_ASSET_ENTRIES, {
          pruneMissing: true,
        });
      });
    }, NAVIGATION_CACHE_PRELOAD_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentImagePath, currentIndex, images, loadGeneration]);

  const handleImageLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  const updateImageBounds = useCallback(() => {
    const container = containerRef.current;
    const image = imgRef.current;
    if (!container || !image) {
      setImageBounds(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    setImageBounds({
      left: imageRect.left - containerRect.left,
      top: imageRect.top - containerRect.top,
      width: imageRect.width,
      height: imageRect.height,
    });
  }, []);

  useEffect(() => {
    updateImageBounds();
    window.addEventListener('resize', updateImageBounds);
    return () => window.removeEventListener('resize', updateImageBounds);
  }, [updateImageBounds, currentImagePath, zoomMode, zoomLevel, panX, panY, rotation, pendingCropPreview, isCropMode]);

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

    if (pendingCropPreview && !isCropMode) {
      style.clipPath = getPreviewClipPath(pendingCropPreview);
      style.transformOrigin = 'center center';
    }

    return style;
  }, [
    isCropMode,
    isFullResolutionReady,
    metadata?.height,
    metadata?.width,
    panX,
    panY,
    pendingCropPreview,
    rotation,
    zoomLevel,
    zoomMode,
  ]);

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
          onLoad={() => {
            handleImageLoad();
            updateImageBounds();
          }}
          draggable={false}
        />
      )}
      {isCropMode && cropRect && rotation === 0 && imageBounds && (
        <CropOverlay imageBounds={imageBounds} cropRect={cropRect} />
      )}
    </div>
  );
}

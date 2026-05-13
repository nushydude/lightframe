import {
  useRef,
  useState,
  useCallback,
  useEffect,
  type CSSProperties,
  type SyntheticEvent,
} from 'react';
import { useViewerStore, type ZoomMode } from '../state/viewerStore';
import {
  getFullAsset,
  getPreviewAsset,
  preloadFullAsset,
  preloadPreviewAsset,
  trimImageAssetCache,
} from '../services/imageAssetCache';
import {
  recordFullResolutionReadyTelemetry,
  recordPreviewVisibleTelemetry,
  recordVisibleImageSourceUpdatedTelemetry,
} from '../services/performanceTelemetry';
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
import { CropOverlay } from './CropOverlay';
import { getPreviewClipPath } from './cropPreview';

type ImageCanvasProps = {
  onWheelNext?: () => void;
  onWheelPrev?: () => void;
};

type LoadedImageAsset = {
  path: string;
  url: string;
};

type ImageStyleOptions = {
  zoomMode: ZoomMode;
  panX: number;
  panY: number;
  rotation: number;
  zoomLevel: number;
  isFullResolutionReady: boolean;
  metadata: ImageMetadata | null;
  pendingCropPreview: ReturnType<typeof useViewerStore.getState>['pendingCropPreview'];
  isCropMode: boolean;
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

function getImageStyle({
  zoomMode,
  panX,
  panY,
  rotation,
  zoomLevel,
  isFullResolutionReady,
  metadata,
  pendingCropPreview,
  isCropMode,
}: ImageStyleOptions): CSSProperties {
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
    style.transform = rotationStr;

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
}

/** Main image display canvas with zoom/pan support */
export function ImageCanvas({ onWheelNext, onWheelPrev }: ImageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isMountedRef = useRef(true);
  const activeRequestIdRef = useRef(0);
  const fullLoadKeyRef = useRef<string | null>(null);
  const imageDisplayErrorRef = useRef<string | null>(null);
  const metadataByPathRef = useRef(new Map<string, ImageMetadata>());
  const zoomStateRef = useRef<{ zoomMode: ZoomMode; zoomLevel: number }>({
    zoomMode: 'fit',
    zoomLevel: 1,
  });
  const [imageBounds, setImageBounds] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
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
    setError,
  } = useViewerStore();
  const { zoomLevel, panX, panY, isDragging, handleMouseDown, handleMouseMove, handleMouseUp } =
    useZoomPan(containerRef, { onWheelNext, onWheelPrev });

  const [previewAsset, setPreviewAsset] = useState<LoadedImageAsset | null>(null);
  const [fullAsset, setFullAsset] = useState<LoadedImageAsset | null>(null);
  const [isFullResolutionReady, setIsFullResolutionReady] = useState(false);
  const [metadata, setMetadata] = useState<ImageMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fullLoadFailed, setFullLoadFailed] = useState(false);
  const [previewDisplayFailed, setPreviewDisplayFailed] = useState(false);

  const images = useViewerStore((s) => s.images);

  useEffect(() => {
    zoomStateRef.current = { zoomMode, zoomLevel };
  }, [zoomLevel, zoomMode]);

  const setImageDisplayError = useCallback(
    (message: string) => {
      imageDisplayErrorRef.current = message;
      setError(message);
    },
    [setError]
  );

  const clearImageDisplayError = useCallback(() => {
    if (!imageDisplayErrorRef.current) {
      return;
    }

    imageDisplayErrorRef.current = null;
    setError(null);
  }, [setError]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeRequestIdRef.current += 1;
      fullLoadKeyRef.current = null;
    };
  }, []);

  const ensureFullResolutionLoaded = useCallback(
    (path: string, requestId: number) => {
      const loadKey = `${path}::${requestId}`;
      if (fullLoadKeyRef.current === loadKey) {
        return;
      }
      fullLoadKeyRef.current = loadKey;

      try {
        const url = getFullAsset(path);
        if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
          return;
        }

        setFullAsset({ path, url });
        setFullLoadFailed(false);
      } catch (err) {
        if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
          return;
        }
        console.error('Failed to load full-resolution image:', err);
        setIsLoading(false);
        setFullLoadFailed(true);
        setImageDisplayError(`Could not create image URL: ${path}`);
      }
    },
    [setImageDisplayError]
  );

  // Load preview first, then full-resolution pixels on demand.
  useEffect(() => {
    if (!currentImagePath) {
      setPreviewAsset(null);
      setFullAsset(null);
      setMetadata(null);
      setIsFullResolutionReady(false);
      setFullLoadFailed(false);
      setPreviewDisplayFailed(false);
      setIsLoading(false);
      imageDisplayErrorRef.current = null;
      return;
    }

    let cancelled = false;
    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;
    fullLoadKeyRef.current = null;

    setPreviewAsset(null);
    setFullAsset(null);
    setMetadata(null);
    setIsFullResolutionReady(false);
    setFullLoadFailed(false);
    setPreviewDisplayFailed(false);
    setIsLoading(true);
    imageDisplayErrorRef.current = null;

    ensureFullResolutionLoaded(currentImagePath, requestId);

    const loadImage = async () => {
      let imageMetadata: ImageMetadata | null = null;
      try {
        imageMetadata = await getImageMetadata(currentImagePath);
        if (!cancelled && isMountedRef.current && activeRequestIdRef.current === requestId) {
          metadataByPathRef.current.set(currentImagePath, imageMetadata);
          setMetadata(imageMetadata);
        }
      } catch (err) {
        console.warn('Failed to read image metadata:', err);
      }

      try {
        const preview = await getPreviewAsset(currentImagePath, PREVIEW_MAX_DIMENSION);
        if (!cancelled && isMountedRef.current && activeRequestIdRef.current === requestId) {
          setPreviewAsset({ path: currentImagePath, url: preview });
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

    void loadImage();

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

  const previewSrc = previewAsset?.url ?? '';
  const fullSrc = fullAsset?.url ?? '';
  const fullFallbackSrc = fullLoadFailed ? '' : fullSrc;
  const imageSrc = isFullResolutionReady ? fullSrc : previewSrc || fullFallbackSrc;
  const isImageLoading = isLoading && !previewSrc && !isFullResolutionReady;

  useEffect(() => {
    if (!currentImagePath || !imageSrc) {
      return;
    }

    const visibleSourcePath =
      imageSrc === fullSrc
        ? (fullAsset?.path ?? null)
        : imageSrc === previewSrc
          ? (previewAsset?.path ?? null)
          : imageSrc === fullFallbackSrc
            ? (fullAsset?.path ?? null)
            : null;

    if (visibleSourcePath !== currentImagePath) {
      return;
    }

    recordVisibleImageSourceUpdatedTelemetry(currentImagePath);
  }, [currentImagePath, fullAsset, fullFallbackSrc, fullSrc, imageSrc, previewAsset, previewSrc]);

  const handleFullResolutionLoad = useCallback(
    (loadedPath = fullAsset?.path ?? null) => {
      if (loadedPath !== currentImagePath) {
        return;
      }

      setFullLoadFailed(false);
      setIsFullResolutionReady(true);
      setIsLoading(false);
      if (loadedPath) {
        recordFullResolutionReadyTelemetry(loadedPath);
      }
      clearImageDisplayError();
    },
    [clearImageDisplayError, currentImagePath, fullAsset?.path]
  );

  const handleFullResolutionError = useCallback(() => {
    setFullLoadFailed(true);
    setIsFullResolutionReady(false);
    setIsLoading(false);

    if ((!previewSrc || previewDisplayFailed) && currentImagePath) {
      setImageDisplayError(`Could not display image: ${currentImagePath}`);
    }
  }, [currentImagePath, previewDisplayFailed, previewSrc, setImageDisplayError]);

  const handleImageLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      if (fullSrc && event.currentTarget.getAttribute('src') === fullSrc) {
        handleFullResolutionLoad(fullAsset?.path ?? null);
        return;
      }

      if (previewAsset?.path !== currentImagePath || !previewAsset?.path) {
        return;
      }

      setIsLoading(false);
      setPreviewDisplayFailed(false);
      recordPreviewVisibleTelemetry(previewAsset.path);
      clearImageDisplayError();
    },
    [
      clearImageDisplayError,
      currentImagePath,
      fullAsset?.path,
      fullSrc,
      handleFullResolutionLoad,
      previewAsset,
    ]
  );

  const handleImageError = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      if (fullSrc && event.currentTarget.getAttribute('src') === fullSrc) {
        handleFullResolutionError();
        return;
      }

      if (currentImagePath && fullSrc && !fullLoadFailed) {
        setPreviewDisplayFailed(true);
        setIsLoading(true);
        return;
      }

      if (currentImagePath && previewSrc && !isFullResolutionReady && !fullLoadFailed) {
        setPreviewDisplayFailed(true);
        setIsLoading(true);
        ensureFullResolutionLoaded(currentImagePath, activeRequestIdRef.current);
        return;
      }

      setIsLoading(false);
      setPreviewDisplayFailed(true);
      if (currentImagePath) {
        setImageDisplayError(`Could not display image: ${currentImagePath}`);
      }
    },
    [
      currentImagePath,
      ensureFullResolutionLoaded,
      fullLoadFailed,
      fullSrc,
      handleFullResolutionError,
      isFullResolutionReady,
      previewSrc,
      setImageDisplayError,
    ]
  );

  const shouldPreloadFullImage =
    Boolean(fullSrc) && Boolean(previewSrc) && !isFullResolutionReady && !fullLoadFailed;

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
  }, [
    updateImageBounds,
    currentImagePath,
    zoomMode,
    zoomLevel,
    panX,
    panY,
    rotation,
    pendingCropPreview,
    isCropMode,
  ]);

  const containerClasses = [
    'image-canvas',
    isDragging ? 'dragging' : '',
    zoomMode === 'actual' || zoomMode === 'custom' ? 'zoomable' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const imageStyle = getImageStyle({
    zoomMode,
    panX,
    panY,
    rotation,
    zoomLevel,
    isFullResolutionReady,
    metadata,
    pendingCropPreview,
    isCropMode,
  });

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
          key={imageSrc}
          ref={imgRef}
          src={imageSrc}
          alt=""
          className={`${zoomMode} ${isImageLoading ? 'loading' : ''}`}
          style={imageStyle}
          onLoad={(event) => {
            handleImageLoad(event);
            updateImageBounds();
          }}
          onError={handleImageError}
          draggable={false}
        />
      )}
      {shouldPreloadFullImage && (
        <img
          key={fullSrc}
          src={fullSrc}
          alt=""
          className="image-full-loader"
          onLoad={() => handleFullResolutionLoad(fullAsset?.path ?? null)}
          onError={handleFullResolutionError}
          aria-hidden="true"
          draggable={false}
        />
      )}
      {isCropMode && cropRect && rotation === 0 && imageBounds && (
        <CropOverlay imageBounds={imageBounds} cropRect={cropRect} />
      )}
    </div>
  );
}

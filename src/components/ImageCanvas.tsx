import { useRef, useState, useCallback, useEffect, useMemo, type SyntheticEvent } from 'react';
import { useViewerStore, type ZoomMode } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import {
  getPreviewAsset,
  preloadFullAsset,
  preloadPreviewAsset,
  requestFullAsset,
  trimImageAssetCache,
} from '../services/imageAssetCache';
import { IMAGE_WORK_PRIORITY, imageWorkScheduler } from '../services/imageWorkScheduler';
import {
  recordFullResolutionReadyTelemetry,
  recordImageCodecTelemetry,
  recordPreviewVisibleTelemetry,
  recordVisibleImageSourceUpdatedTelemetry,
} from '../services/performanceTelemetry';
import {
  NAVIGATION_CACHE_MAX_FULL_ASSET_ENTRIES,
  NAVIGATION_CACHE_PRELOAD_DEBOUNCE_MS,
} from '../services/navigationCacheConfig';
import { getPerformanceModeProfile } from '../services/performanceMode';
import { BoundedPathMetadataCache } from '../services/pathMetadataCache';
import { pathIdentityKey } from '../services/pathIdentity';
import {
  acknowledgeSessionAssetDeliveryResponses,
  getActiveSessionForPath,
  getImageMetadata,
  isProjectorGrantOnlySession,
  releaseSessionAssetDelivery,
} from '../services/tauriCommands';
import type { ImageMetadata } from '../types/image';
import { useZoomPan } from '../hooks/useZoomPan';
import {
  canRequestFullResolutionSafely,
  getFullResolutionSafetyMessage,
  PREVIEW_MAX_DIMENSION,
  shouldPreloadAdjacentFullResolution,
  shouldLoadFullResolutionImmediately,
  shouldRequestFullResolution,
} from './imagePreviewStrategy';
import { CropOverlay } from './CropOverlay';
import { TiledImageRenderer } from './TiledImageRenderer';
import {
  isTiledRendererCandidate,
  shouldDeferFullResolutionForTiledCandidate,
  shouldUseTiledRenderer,
} from './tiledRenderer';
import { getRenderedImageBounds, getImageStyle, type ImageBounds } from './imageCanvasLayout';
import { getAdjacentPreloadPlan, type NavigationDirection } from './imageCanvasPreload';

type ImageCanvasProps = {
  onWheelNext?: () => void;
  onWheelPrev?: () => void;
};

type LoadedImageAsset = {
  path: string;
  url: string;
};

type MetadataLoadState = {
  path: string | null;
  metadata: ImageMetadata | null;
  resolved: boolean;
};

const PREVIEW_STALL_FULL_RESOLUTION_DELAY_MS = 350;
const EMPTY_METADATA_LOAD_STATE: MetadataLoadState = {
  path: null,
  metadata: null,
  resolved: false,
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Main image display canvas with zoom/pan support */
// fallow-ignore-next-line complexity -- image loading orchestration boundary
export function ImageCanvas({ onWheelNext, onWheelPrev }: ImageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isMountedRef = useRef(true);
  const activeRequestIdRef = useRef(0);
  const activeWorkAbortControllerRef = useRef<AbortController | null>(null);
  const fullLoadKeyRef = useRef<string | null>(null);
  const imageDisplayErrorRef = useRef<string | null>(null);
  const fullResolutionSafetyMessageRef = useRef<string | null>(null);
  const metadataByPathRef = useRef(new BoundedPathMetadataCache<ImageMetadata>());
  const previousIndexRef = useRef<number | null>(null);
  const navigationDirectionRef = useRef<NavigationDirection>('idle');
  const zoomStateRef = useRef<{ zoomMode: ZoomMode; zoomLevel: number }>({
    zoomMode: 'fit',
    zoomLevel: 1,
  });
  const [imageBounds, setImageBounds] = useState<ImageBounds | null>(null);
  const currentImagePath = useViewerStore((state) => state.currentImagePath);
  const zoomMode = useViewerStore((state) => state.zoomMode);
  const currentIndex = useViewerStore((state) => state.currentIndex);
  const rotation = useViewerStore((state) => state.rotation);
  const cacheBuster = useViewerStore((state) => state.cacheBuster);
  const loadGeneration = useViewerStore((state) => state.loadGeneration);
  const isCropMode = useViewerStore((state) => state.isCropMode);
  const cropRect = useViewerStore((state) => state.cropRect);
  const pendingCropPreview = useViewerStore((state) => state.pendingCropPreview);
  const setError = useViewerStore((state) => state.setError);
  const {
    zoomLevel,
    panX,
    panY,
    isDragging,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
  } = useZoomPan(containerRef, { onWheelNext, onWheelPrev });

  const [previewAsset, setPreviewAsset] = useState<LoadedImageAsset | null>(null);
  const [fullAsset, setFullAsset] = useState<LoadedImageAsset | null>(null);
  const [isFullResolutionReady, setIsFullResolutionReady] = useState(false);
  const [metadataLoadState, setMetadataLoadState] =
    useState<MetadataLoadState>(EMPTY_METADATA_LOAD_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [fullLoadFailed, setFullLoadFailed] = useState(false);

  useEffect(() => {
    const url = fullAsset?.url;
    if (!url) return;
    return () => {
      void acknowledgeSessionAssetDeliveryResponses(url);
      void releaseSessionAssetDelivery(url);
    };
  }, [fullAsset?.url]);
  const [previewDisplayFailed, setPreviewDisplayFailed] = useState(false);
  const [tileLoadFailed, setTileLoadFailed] = useState(false);

  const images = useViewerStore((s) => s.images);
  const allImages = useViewerStore((s) => s.allImages);
  const performanceMode = useSettingsStore((state) => state.settings.performanceMode);
  const performanceProfile = getPerformanceModeProfile(performanceMode);
  const cacheRetentionPaths = useMemo(
    () => new Set((allImages.length > 0 ? allImages : images).map((image) => image.path)),
    [allImages, images]
  );
  const metadata = metadataLoadState.path === currentImagePath ? metadataLoadState.metadata : null;
  const isMetadataResolved =
    Boolean(currentImagePath) &&
    metadataLoadState.path === currentImagePath &&
    metadataLoadState.resolved;

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

  const clearFullResolutionSafetyMessage = useCallback(() => {
    const safetyMessage = fullResolutionSafetyMessageRef.current;
    fullResolutionSafetyMessageRef.current = null;

    if (safetyMessage && imageDisplayErrorRef.current === safetyMessage) {
      clearImageDisplayError();
    }
  }, [clearImageDisplayError]);

  const blockUnsafeFullResolutionLoad = useCallback(
    (imageMetadata: ImageMetadata | null) => {
      const safetyMessage = getFullResolutionSafetyMessage(imageMetadata);
      if (!safetyMessage) {
        clearFullResolutionSafetyMessage();
        return false;
      }

      fullResolutionSafetyMessageRef.current = safetyMessage;
      fullLoadKeyRef.current = null;
      setFullLoadFailed(true);
      setIsLoading(false);
      setImageDisplayError(safetyMessage);
      return true;
    },
    [clearFullResolutionSafetyMessage, setImageDisplayError]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeRequestIdRef.current += 1;
      activeWorkAbortControllerRef.current?.abort();
      activeWorkAbortControllerRef.current = null;
      fullLoadKeyRef.current = null;
    };
  }, []);

  const ensureFullResolutionLoaded = useCallback(
    (path: string, requestId: number, signal?: AbortSignal) => {
      const loadKey = `${path}::${requestId}`;
      if (fullLoadKeyRef.current === loadKey) {
        return;
      }
      fullLoadKeyRef.current = loadKey;

      const state = useViewerStore.getState();
      const normPath = pathIdentityKey(path);
      const foundImg =
        state.images.find((img) => pathIdentityKey(img.path) === normPath) ||
        state.images[state.currentIndex];
      const sessionInfo = getActiveSessionForPath(path);

      const targetSessionId =
        foundImg?.sessionId || sessionInfo?.sessionId || state.activeSessionId;
      const targetId = foundImg?.id || sessionInfo?.imageId;

      if (!targetSessionId || !targetId) {
        return;
      }

      const targetArg = { path, sessionId: targetSessionId, id: targetId };
      void requestFullAsset(targetArg, { signal })
        .then((url) => {
          if (
            signal?.aborted ||
            !isMountedRef.current ||
            activeRequestIdRef.current !== requestId
          ) {
            void releaseSessionAssetDelivery(url);
            return;
          }

          setFullAsset({ path, url });
          setFullLoadFailed(false);
        })
        .catch((err) => {
          if (
            isAbortError(err) ||
            signal?.aborted ||
            !isMountedRef.current ||
            activeRequestIdRef.current !== requestId
          ) {
            return;
          }

          console.error('Failed to load full-resolution image:', err);
          setIsLoading(false);
          setFullLoadFailed(true);
          setImageDisplayError(`Could not create image URL: ${path}`);
        });
    },
    [setImageDisplayError]
  );

  const isActiveRequest = useCallback(
    (requestId: number) => isMountedRef.current && activeRequestIdRef.current === requestId,
    []
  );

  const loadMetadataForPath = useCallback(
    async (path: string, requestId: number, signal: AbortSignal) =>
      imageWorkScheduler.schedule({
        key: `metadata::${path}`,
        priority: IMAGE_WORK_PRIORITY.currentMetadata,
        sourcePath: path,
        generationToken: requestId,
        signal,
        run: async ({ signal: workSignal }) => {
          if (workSignal.aborted) {
            throw Object.assign(new Error('Metadata work aborted before execution.'), {
              name: 'AbortError',
            });
          }
          const nextMetadata = await getImageMetadata(path);
          if (workSignal.aborted) {
            throw Object.assign(new Error('Metadata work aborted after execution.'), {
              name: 'AbortError',
            });
          }
          return nextMetadata;
        },
      }).promise,
    []
  );

  const loadPreviewForPath = useCallback((path: string, signal: AbortSignal) => {
    const state = useViewerStore.getState();
    const normalized = pathIdentityKey(path);
    const image = state.images.find((candidate) => pathIdentityKey(candidate.path) === normalized);
    return getPreviewAsset(image ?? path, PREVIEW_MAX_DIMENSION, { signal });
  }, []);

  // Load preview first, then full-resolution pixels on demand.
  useEffect(() => {
    if (!currentImagePath) {
      metadataByPathRef.current.retain([]);
      activeWorkAbortControllerRef.current?.abort();
      activeWorkAbortControllerRef.current = null;
      setPreviewAsset(null);
      setFullAsset(null);
      setMetadataLoadState(EMPTY_METADATA_LOAD_STATE);
      setIsFullResolutionReady(false);
      setFullLoadFailed(false);
      setPreviewDisplayFailed(false);
      setTileLoadFailed(false);
      setIsLoading(false);
      imageDisplayErrorRef.current = null;
      fullResolutionSafetyMessageRef.current = null;
      return;
    }

    let cancelled = false;
    metadataByPathRef.current.retain([currentImagePath]);
    let previewSettled = false;
    let previewFallbackTimer: number | null = null;
    const currentWorkAbortController = new AbortController();
    activeWorkAbortControllerRef.current?.abort();
    activeWorkAbortControllerRef.current = currentWorkAbortController;
    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;
    fullLoadKeyRef.current = null;

    setPreviewAsset(null);
    setFullAsset(null);
    setMetadataLoadState({
      path: currentImagePath,
      metadata: null,
      resolved: false,
    });
    setIsFullResolutionReady(false);
    setFullLoadFailed(false);
    setPreviewDisplayFailed(false);
    setTileLoadFailed(false);
    setIsLoading(true);
    imageDisplayErrorRef.current = null;
    fullResolutionSafetyMessageRef.current = null;

    const isCurrentRequest = () => !cancelled && isActiveRequest(requestId);
    const loadCurrentMetadata = async (): Promise<ImageMetadata | null> => {
      try {
        const imageMetadata = await loadMetadataForPath(
          currentImagePath,
          requestId,
          currentWorkAbortController.signal
        );
        if (isCurrentRequest()) {
          metadataByPathRef.current.set(currentImagePath, imageMetadata);
          setMetadataLoadState({
            path: currentImagePath,
            metadata: imageMetadata,
            resolved: true,
          });
          recordImageCodecTelemetry(
            currentImagePath,
            imageMetadata.codec_backend ?? 'unsupported',
            imageMetadata.native_decode_supported ?? false
          );
        }
        return imageMetadata;
      } catch (err) {
        if (!isAbortError(err)) {
          console.warn('Failed to read image metadata:', err);
        }
        if (isCurrentRequest()) {
          setMetadataLoadState({
            path: currentImagePath,
            metadata: null,
            resolved: true,
          });
        }
        return null;
      }
    };

    const getInitialRenderPlan = (imageMetadata: ImageMetadata | null) => {
      const { zoomMode: currentZoomMode, zoomLevel: currentZoomLevel } = zoomStateRef.current;
      const viewerSnapshot = useViewerStore.getState();
      const isTileCandidate = isTiledRendererCandidate(imageMetadata, currentImagePath);
      const shouldUseTiles =
        isTileCandidate &&
        shouldUseTiledRenderer({
          metadata: imageMetadata,
          filePath: currentImagePath,
          zoomMode: currentZoomMode,
          zoomLevel: currentZoomLevel,
          rotation: viewerSnapshot.rotation,
          isCropMode: viewerSnapshot.isCropMode,
          hasPendingCropPreview: Boolean(viewerSnapshot.pendingCropPreview),
        });
      const shouldDeferFull = shouldDeferFullResolutionForTiledCandidate({
        metadata: imageMetadata,
        filePath: currentImagePath,
        zoomMode: currentZoomMode,
        zoomLevel: currentZoomLevel,
        rotation: viewerSnapshot.rotation,
        isCropMode: viewerSnapshot.isCropMode,
        hasPendingCropPreview: Boolean(viewerSnapshot.pendingCropPreview),
      });
      const shouldRequestFull =
        !shouldUseTiles &&
        !shouldDeferFull &&
        shouldLoadFullResolutionImmediately(
          imageMetadata,
          currentZoomMode,
          currentZoomLevel,
          PREVIEW_MAX_DIMENSION
        );

      return { shouldDeferFull, shouldRequestFull, shouldUseTiles };
    };

    const queueInitialFullLoad = (shouldRequestFull: boolean) => {
      if (!shouldRequestFull || !isCurrentRequest()) {
        return;
      }

      ensureFullResolutionLoaded(currentImagePath, requestId, currentWorkAbortController.signal);
    };

    const clearPreviewFallbackTimer = () => {
      if (previewFallbackTimer == null) {
        return;
      }

      window.clearTimeout(previewFallbackTimer);
      previewFallbackTimer = null;
    };

    const queuePreviewFallbackFullLoad = (
      imageMetadata: ImageMetadata | null,
      shouldUseTiles: boolean,
      shouldDeferFull: boolean
    ) => {
      if (shouldUseTiles || shouldDeferFull || !canRequestFullResolutionSafely(imageMetadata)) {
        return;
      }

      clearPreviewFallbackTimer();
      previewFallbackTimer = window.setTimeout(() => {
        previewFallbackTimer = null;
        if (previewSettled || !isCurrentRequest()) {
          return;
        }

        ensureFullResolutionLoaded(currentImagePath, requestId, currentWorkAbortController.signal);
      }, PREVIEW_STALL_FULL_RESOLUTION_DELAY_MS);
    };

    const loadCurrentPreview = async (
      shouldUseTiles: boolean,
      imageMetadata: ImageMetadata | null
    ) => {
      try {
        const preview = await loadPreviewForPath(
          currentImagePath,
          currentWorkAbortController.signal
        );
        if (isCurrentRequest()) {
          previewSettled = true;
          clearPreviewFallbackTimer();
          setPreviewAsset({ path: currentImagePath, url: preview });
        }
      } catch (err) {
        if (isAbortError(err)) {
          return;
        }
        previewSettled = true;
        clearPreviewFallbackTimer();
        console.error('Failed to load preview image:', err);
        if (shouldUseTiles && isCurrentRequest()) {
          setIsLoading(false);
          return;
        }
        if (
          !shouldUseTiles &&
          isCurrentRequest() &&
          !canRequestFullResolutionSafely(imageMetadata)
        ) {
          blockUnsafeFullResolutionLoad(imageMetadata);
          return;
        }
        if (!shouldUseTiles && isCurrentRequest()) {
          ensureFullResolutionLoaded(
            currentImagePath,
            requestId,
            currentWorkAbortController.signal
          );
        }
        return;
      }
    };

    const loadImage = async () => {
      const imageMetadata = await loadCurrentMetadata();
      const { shouldDeferFull, shouldRequestFull, shouldUseTiles } =
        getInitialRenderPlan(imageMetadata);
      queueInitialFullLoad(shouldRequestFull);
      if (!shouldRequestFull) {
        queuePreviewFallbackFullLoad(imageMetadata, shouldUseTiles, shouldDeferFull);
      }
      await loadCurrentPreview(shouldUseTiles, imageMetadata);
    };

    void loadImage();

    return () => {
      cancelled = true;
      clearPreviewFallbackTimer();
      currentWorkAbortController.abort();
      if (activeWorkAbortControllerRef.current === currentWorkAbortController) {
        activeWorkAbortControllerRef.current = null;
      }
    };
  }, [
    cacheBuster,
    currentImagePath,
    ensureFullResolutionLoaded,
    isActiveRequest,
    blockUnsafeFullResolutionLoad,
    loadMetadataForPath,
    loadPreviewForPath,
  ]);

  useEffect(() => {
    if (!currentImagePath || isFullResolutionReady) {
      return;
    }

    if (!shouldRequestFullResolution(zoomMode, zoomLevel)) {
      clearFullResolutionSafetyMessage();
      return;
    }

    if (!isMetadataResolved) {
      return;
    }

    if (
      !tileLoadFailed &&
      shouldUseTiledRenderer({
        metadata,
        filePath: currentImagePath,
        zoomMode,
        zoomLevel,
        rotation,
        isCropMode,
        hasPendingCropPreview: Boolean(pendingCropPreview),
      })
    ) {
      return;
    }

    if (
      shouldDeferFullResolutionForTiledCandidate({
        metadata,
        filePath: currentImagePath,
        zoomMode,
        zoomLevel,
        rotation,
        isCropMode,
        hasPendingCropPreview: Boolean(pendingCropPreview),
      })
    ) {
      return;
    }

    if (blockUnsafeFullResolutionLoad(metadata)) {
      return;
    }

    ensureFullResolutionLoaded(
      currentImagePath,
      activeRequestIdRef.current,
      activeWorkAbortControllerRef.current?.signal
    );
  }, [
    currentImagePath,
    clearFullResolutionSafetyMessage,
    ensureFullResolutionLoaded,
    isCropMode,
    isFullResolutionReady,
    isMetadataResolved,
    blockUnsafeFullResolutionLoad,
    metadata,
    pendingCropPreview,
    rotation,
    tileLoadFailed,
    zoomLevel,
    zoomMode,
  ]);

  useEffect(() => {
    const previousIndex = previousIndexRef.current;
    if (previousIndex == null || currentIndex < 0) {
      navigationDirectionRef.current = 'idle';
    } else if (currentIndex > previousIndex) {
      navigationDirectionRef.current = 'forward';
    } else if (currentIndex < previousIndex) {
      navigationDirectionRef.current = 'backward';
    }

    previousIndexRef.current = currentIndex >= 0 ? currentIndex : null;
  }, [currentIndex]);

  useEffect(() => {
    trimImageAssetCache(cacheRetentionPaths, Number.POSITIVE_INFINITY, { pruneMissing: true });
  }, [cacheRetentionPaths]);

  // Preload adjacent images
  useEffect(() => {
    if (images.length === 0 || currentIndex < 0) return;

    let cancelled = false;
    const preloadAbortController = new AbortController();
    const { keepIndices, preloadIndices, leadingIndices } = getAdjacentPreloadPlan(
      currentIndex,
      images.length,
      navigationDirectionRef.current,
      performanceProfile.adjacentPreviousImages,
      performanceProfile.adjacentNextImages
    );
    const keepSet = new Set(keepIndices.map((index) => images[index].path));
    if (currentImagePath) {
      keepSet.add(currentImagePath);
    }
    metadataByPathRef.current.retain(keepSet);
    const scheduledLoadGeneration = loadGeneration;
    const canStore = () =>
      !cancelled &&
      !preloadAbortController.signal.aborted &&
      isMountedRef.current &&
      useViewerStore.getState().loadGeneration === scheduledLoadGeneration;

    // Debounce preloading so quick scanning does not flood cache requests.
    const timer = window.setTimeout(() => {
      if (!canStore()) {
        return;
      }
      // The secondary renderer owns only the current backend-issued projector grant. Avoid
      // speculative adjacent reads that are outside that grant and would only churn IPC.
      if (isProjectorGrantOnlySession()) {
        return;
      }

      const activeSessionId = useViewerStore.getState().activeSessionId;
      const preloadPromises = preloadIndices
        .map((index) => ({ img: images[index], index }))
        .filter(
          (entry): entry is { img: (typeof images)[number]; index: number } =>
            Boolean(entry.img?.path) && entry.img.path !== currentImagePath
        )
        .map(({ img, index }) => {
          const metadataForPath = metadataByPathRef.current.get(img.path) ?? null;
          const priority = leadingIndices.has(index)
            ? IMAGE_WORK_PRIORITY.adjacentDirectional
            : IMAGE_WORK_PRIORITY.backgroundPreload;
          const targetSessionId = img.sessionId || activeSessionId;
          const targetId = img.id;
          const preloadPromise =
            shouldPreloadAdjacentFullResolution(metadataForPath, PREVIEW_MAX_DIMENSION) &&
            targetSessionId &&
            targetId
              ? preloadFullAsset(
                  { path: img.path, sessionId: targetSessionId, id: targetId },
                  {
                    canStore,
                    signal: preloadAbortController.signal,
                    priority,
                  }
                )
              : preloadPreviewAsset(img, PREVIEW_MAX_DIMENSION, {
                  canStore,
                  signal: preloadAbortController.signal,
                  priority,
                });

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
          pruneMissingPaths: cacheRetentionPaths,
          cancelOutsidePaths: cacheRetentionPaths,
        });
      });
    }, NAVIGATION_CACHE_PRELOAD_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      preloadAbortController.abort();
      window.clearTimeout(timer);
    };
  }, [
    cacheRetentionPaths,
    currentImagePath,
    currentIndex,
    images,
    loadGeneration,
    performanceProfile,
  ]);

  const previewSrc = previewAsset?.url ?? '';
  const fullSrc = fullAsset?.url ?? '';
  const fullFallbackSrc = fullLoadFailed ? '' : fullSrc;
  const isTiledRendererActive =
    !tileLoadFailed &&
    shouldUseTiledRenderer({
      metadata,
      filePath: currentImagePath,
      zoomMode,
      zoomLevel,
      rotation,
      isCropMode,
      hasPendingCropPreview: Boolean(pendingCropPreview),
    });
  const imageSrc = isTiledRendererActive
    ? previewSrc
    : isFullResolutionReady
      ? fullSrc
      : previewSrc || fullFallbackSrc;
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
      const deliveryUrl = event.currentTarget.currentSrc || event.currentTarget.src;
      void acknowledgeSessionAssetDeliveryResponses(deliveryUrl);
      void releaseSessionAssetDelivery(deliveryUrl);
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
      if (imageDisplayErrorRef.current !== fullResolutionSafetyMessageRef.current) {
        clearImageDisplayError();
      }
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
      const deliveryUrl = event.currentTarget.currentSrc || event.currentTarget.src;
      void acknowledgeSessionAssetDeliveryResponses(deliveryUrl);
      void releaseSessionAssetDelivery(deliveryUrl);
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
        ensureFullResolutionLoaded(
          currentImagePath,
          activeRequestIdRef.current,
          activeWorkAbortControllerRef.current?.signal
        );
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

  const handleTiledPreviewLoad = useCallback(() => {
    if (previewAsset?.path !== currentImagePath || !previewAsset?.path) {
      return;
    }

    setIsLoading(false);
    setPreviewDisplayFailed(false);
    recordPreviewVisibleTelemetry(previewAsset.path);
    if (imageDisplayErrorRef.current !== fullResolutionSafetyMessageRef.current) {
      clearImageDisplayError();
    }
  }, [clearImageDisplayError, currentImagePath, previewAsset]);

  const handleTiledPreviewError = useCallback(() => {
    setPreviewDisplayFailed(true);
    setIsLoading(false);
  }, []);

  const handleTileLoadError = useCallback(() => {
    if (!currentImagePath) {
      return;
    }

    setTileLoadFailed(true);
    if (blockUnsafeFullResolutionLoad(metadata)) {
      return;
    }

    ensureFullResolutionLoaded(
      currentImagePath,
      activeRequestIdRef.current,
      activeWorkAbortControllerRef.current?.signal
    );
  }, [blockUnsafeFullResolutionLoad, currentImagePath, ensureFullResolutionLoaded, metadata]);

  const shouldPreloadFullImage =
    !isTiledRendererActive &&
    Boolean(fullSrc) &&
    Boolean(previewSrc) &&
    !isFullResolutionReady &&
    !fullLoadFailed;

  const updateImageBounds = useCallback(() => {
    const container = containerRef.current;
    const image = imgRef.current;
    if (!container || !image) {
      setImageBounds(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    setImageBounds(
      getRenderedImageBounds({
        containerRect,
        image,
        imageRect,
        metadata,
        zoomMode,
      })
    );
  }, [metadata, zoomMode]);

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
      onWheel={handleWheel}
    >
      {isTiledRendererActive && metadata && (
        <TiledImageRenderer
          key={`${currentImagePath}::${metadata.file_size_bytes}::${metadata.width}::${metadata.height}`}
          containerRef={containerRef}
          filePath={currentImagePath}
          metadata={metadata}
          previewSrc={previewSrc}
          zoomMode={zoomMode}
          zoomLevel={zoomLevel}
          panX={panX}
          panY={panY}
          onPreviewLoad={handleTiledPreviewLoad}
          onPreviewError={handleTiledPreviewError}
          onTileError={handleTileLoadError}
        />
      )}
      {!isTiledRendererActive && imageSrc && (
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
          onLoad={(event) => {
            const deliveryUrl = event.currentTarget.currentSrc || event.currentTarget.src;
            void acknowledgeSessionAssetDeliveryResponses(deliveryUrl);
            void releaseSessionAssetDelivery(deliveryUrl);
            handleFullResolutionLoad(fullAsset?.path ?? null);
          }}
          onError={(event) => {
            const deliveryUrl = event.currentTarget.currentSrc || event.currentTarget.src;
            void acknowledgeSessionAssetDeliveryResponses(deliveryUrl);
            void releaseSessionAssetDelivery(deliveryUrl);
            handleFullResolutionError();
          }}
          aria-hidden="true"
          draggable={false}
        />
      )}
      {!isTiledRendererActive && isCropMode && cropRect && rotation === 0 && imageBounds && (
        <CropOverlay imageBounds={imageBounds} cropRect={cropRect} />
      )}
    </div>
  );
}

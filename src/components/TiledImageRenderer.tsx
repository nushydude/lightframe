import { useEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from 'react';
import { generatedImageAssetToUrl, getImageTile } from '../services/tauriCommands';
import { IMAGE_WORK_PRIORITY, imageWorkScheduler } from '../services/imageWorkScheduler';
import { measurePerformanceSpan } from '../services/performanceTelemetry';
import type { ZoomMode } from '../state/viewerStore';
import type { ImageMetadata } from '../types/image';
import {
  getTiledImageLayout,
  getVisibleTileRequests,
  TILE_SIZE,
  type TileRequest,
} from './tiledRenderer';

type TiledImageRendererProps = {
  containerRef: RefObject<HTMLDivElement | null>;
  filePath: string;
  metadata: ImageMetadata;
  previewSrc: string;
  zoomMode: ZoomMode;
  zoomLevel: number;
  panX: number;
  panY: number;
  onPreviewLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
  onPreviewError: (event: SyntheticEvent<HTMLImageElement>) => void;
  onTileError: (error: unknown) => void;
};

type ElementSize = {
  width: number;
  height: number;
};

type TileWorkState = {
  sourceKey: string;
  workKey: string;
};

function measureElement(element: HTMLElement | null): ElementSize {
  if (!element) {
    return { width: 0, height: 0 };
  }

  const rect = element.getBoundingClientRect();
  return {
    width: rect.width || element.clientWidth,
    height: rect.height || element.clientHeight,
  };
}

function sameSize(left: ElementSize, right: ElementSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function tileWorkKey(
  filePath: string,
  metadata: ImageMetadata,
  tileSize: number,
  request: TileRequest
): string {
  return [
    'tile',
    filePath,
    metadata.file_size_bytes,
    metadata.width,
    metadata.height,
    tileSize,
    request.tileX,
    request.tileY,
  ].join('::');
}

function tileSourceKey(filePath: string, metadata: ImageMetadata): string {
  return `${filePath}::${metadata.file_size_bytes}::${metadata.width}::${metadata.height}`;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function TiledImageRenderer({
  containerRef,
  filePath,
  metadata,
  previewSrc,
  zoomMode,
  zoomLevel,
  panX,
  panY,
  onPreviewLoad,
  onPreviewError,
  onTileError,
}: TiledImageRendererProps) {
  const [containerSize, setContainerSize] = useState<ElementSize>(() =>
    measureElement(containerRef.current)
  );
  const [tileUrls, setTileUrls] = useState<Record<string, string>>({});
  const tileUrlsRef = useRef<Record<string, string>>({});
  const activeSourceKeyRef = useRef<string | null>(tileSourceKey(filePath, metadata));
  const inFlightTileWorkRef = useRef<Map<string, TileWorkState>>(new Map());
  const tileRequestsRef = useRef<TileRequest[]>([]);
  const visibleTileKeysRef = useRef<Set<string>>(new Set());
  const sourceKey = tileSourceKey(filePath, metadata);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const nextSize = measureElement(element);
      setContainerSize((current) => (sameSize(current, nextSize) ? current : nextSize));
    };

    updateSize();
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateSize) : null;
    resizeObserver?.observe(element);
    window.addEventListener('resize', updateSize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [containerRef]);

  useEffect(() => {
    if (activeSourceKeyRef.current === sourceKey) {
      return;
    }

    for (const [tileKey, tileWork] of inFlightTileWorkRef.current) {
      if (tileWork.sourceKey !== sourceKey) {
        imageWorkScheduler.cancelQueued((job) => job.key === tileWork.workKey);
        inFlightTileWorkRef.current.delete(tileKey);
      }
    }

    activeSourceKeyRef.current = sourceKey;
    tileUrlsRef.current = {};
    setTileUrls({});
  }, [sourceKey]);

  useEffect(
    () => () => {
      for (const tileWork of inFlightTileWorkRef.current.values()) {
        imageWorkScheduler.cancelQueued((job) => job.key === tileWork.workKey);
      }
      inFlightTileWorkRef.current.clear();
      activeSourceKeyRef.current = null;
      visibleTileKeysRef.current = new Set();
    },
    []
  );

  const layout = useMemo(
    () =>
      getTiledImageLayout({
        metadata,
        containerWidth: containerSize.width,
        containerHeight: containerSize.height,
        zoomMode,
        zoomLevel,
        panX,
        panY,
      }),
    [containerSize.height, containerSize.width, metadata, panX, panY, zoomLevel, zoomMode]
  );

  const tileRequests = useMemo(
    () =>
      getVisibleTileRequests({
        layout,
        containerWidth: containerSize.width,
        containerHeight: containerSize.height,
        tileSize: TILE_SIZE,
      }),
    [containerSize.height, containerSize.width, layout]
  );
  const requestKey = tileRequests.map((request) => request.key).join('|');
  tileRequestsRef.current = tileRequests;
  visibleTileKeysRef.current = new Set(tileRequests.map((request) => request.key));

  useEffect(() => {
    const keepKeys = new Set(tileRequests.map((request) => request.key));
    setTileUrls((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([tileKey]) => keepKeys.has(tileKey))
      );
      const didPrune = Object.keys(next).length !== Object.keys(current).length;
      if (!didPrune) {
        return current;
      }

      tileUrlsRef.current = next;
      return next;
    });
  }, [requestKey, tileRequests]);

  useEffect(() => {
    const sourceWidth = metadata.width ?? 0;
    const sourceHeight = metadata.height ?? 0;
    const currentTileRequests = tileRequestsRef.current;
    if (sourceWidth <= 0 || sourceHeight <= 0 || currentTileRequests.length === 0) {
      return;
    }

    const requestedKeys = visibleTileKeysRef.current;
    for (const [tileKey, tileWork] of inFlightTileWorkRef.current) {
      if (tileWork.sourceKey !== sourceKey || requestedKeys.has(tileKey)) {
        continue;
      }

      const canceled = imageWorkScheduler.cancelQueued((job) => job.key === tileWork.workKey);
      if (canceled > 0) {
        inFlightTileWorkRef.current.delete(tileKey);
      }
    }

    for (const request of currentTileRequests) {
      if (tileUrlsRef.current[request.key]) {
        continue;
      }

      const existingTileWork = inFlightTileWorkRef.current.get(request.key);
      if (existingTileWork?.sourceKey === sourceKey) {
        continue;
      }

      const workKey = tileWorkKey(filePath, metadata, TILE_SIZE, request);
      inFlightTileWorkRef.current.set(request.key, {
        sourceKey,
        workKey,
      });

      void imageWorkScheduler
        .schedule({
          key: workKey,
          priority: IMAGE_WORK_PRIORITY.currentFull,
          sourcePath: filePath,
          run: async ({ signal }) => {
            if (signal.aborted) {
              throw createAbortError('Tile work aborted before execution.');
            }

            const asset = await measurePerformanceSpan('tileGeneration', () =>
              getImageTile(
                filePath,
                sourceWidth,
                sourceHeight,
                TILE_SIZE,
                request.tileX,
                request.tileY
              )
            );
            if (signal.aborted) {
              throw createAbortError('Tile work aborted after execution.');
            }

            return generatedImageAssetToUrl(asset);
          },
        })
        .promise.then((url) => {
          const tileWork = inFlightTileWorkRef.current.get(request.key);
          if (tileWork?.sourceKey === sourceKey && tileWork.workKey === workKey) {
            inFlightTileWorkRef.current.delete(request.key);
          }

          if (
            activeSourceKeyRef.current !== sourceKey ||
            !visibleTileKeysRef.current.has(request.key)
          ) {
            return;
          }

          setTileUrls((current) => {
            if (current[request.key] === url) {
              return current;
            }

            const next = { ...current, [request.key]: url };
            tileUrlsRef.current = next;
            return next;
          });
        })
        .catch((error) => {
          const tileWork = inFlightTileWorkRef.current.get(request.key);
          if (tileWork?.sourceKey === sourceKey && tileWork.workKey === workKey) {
            inFlightTileWorkRef.current.delete(request.key);
          }

          if (isAbortError(error)) {
            return;
          }

          if (
            activeSourceKeyRef.current !== sourceKey ||
            !visibleTileKeysRef.current.has(request.key)
          ) {
            return;
          }

          console.warn('Failed to load image tile:', error);
          onTileError(error);
        });
    }
  }, [filePath, metadata, metadata.height, metadata.width, onTileError, requestKey, sourceKey]);

  if (!layout) {
    return null;
  }

  return (
    <div
      className="tiled-image-renderer"
      style={{
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
      }}
    >
      {previewSrc && (
        <img
          src={previewSrc}
          alt=""
          className="tiled-image-preview"
          onLoad={onPreviewLoad}
          onError={onPreviewError}
          draggable={false}
        />
      )}
      {tileRequests.map((request) => {
        const tileUrl = tileUrls[request.key];
        if (!tileUrl) {
          return null;
        }

        return (
          <img
            key={request.key}
            src={tileUrl}
            alt=""
            className="tiled-image-tile"
            style={{
              left: request.sourceX * layout.scale,
              top: request.sourceY * layout.scale,
              width: request.width * layout.scale,
              height: request.height * layout.scale,
            }}
            draggable={false}
          />
        );
      })}
    </div>
  );
}

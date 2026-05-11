import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clampPixelRect,
  getAspectRatioValue,
  normalizedToPixelRect,
  pixelToNormalizedRect,
  resizeRectWithHandle,
  type NormalizedCropRect,
  type ResizeHandle,
} from '../services/cropMath';
import { useViewerStore } from '../state/viewerStore';

type CropOverlayProps = {
  imageBounds: { left: number; top: number; width: number; height: number };
  cropRect: NormalizedCropRect;
};

type DragState =
  | {
      mode: 'move';
      pointerId: number;
      startX: number;
      startY: number;
      startRect: ReturnType<typeof normalizedToPixelRect>;
    }
  | {
      mode: 'resize';
      pointerId: number;
      handle: ResizeHandle;
      startX: number;
      startY: number;
      startRect: ReturnType<typeof normalizedToPixelRect>;
      aspectRatio: number | null;
    };

const HANDLE_ORDER: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function CropOverlay({ imageBounds, cropRect }: CropOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [isPointerDragging, setIsPointerDragging] = useState(false);
  const { cropAspectRatio, updateCropRect } = useViewerStore();

  const pixelRect = useMemo(
    () => normalizedToPixelRect(cropRect, imageBounds.width, imageBounds.height),
    [cropRect, imageBounds.height, imageBounds.width]
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;

      if (dragState.mode === 'move') {
        const movedRect = clampPixelRect(
          {
            ...dragState.startRect,
            x: dragState.startRect.x + deltaX,
            y: dragState.startRect.y + deltaY,
          },
          imageBounds.width,
          imageBounds.height
        );
        updateCropRect(pixelToNormalizedRect(movedRect, imageBounds.width, imageBounds.height));
        return;
      }

      const resizedRect = resizeRectWithHandle(
        dragState.startRect,
        dragState.handle,
        deltaX,
        deltaY,
        imageBounds.width,
        imageBounds.height,
        dragState.aspectRatio
      );
      updateCropRect(pixelToNormalizedRect(resizedRect, imageBounds.width, imageBounds.height));
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (dragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }
      dragStateRef.current = null;
      setIsPointerDragging(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [imageBounds.height, imageBounds.width, updateCropRect]);

  const beginMove = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      mode: 'move',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: pixelRect,
    };
    setIsPointerDragging(true);
  };

  const beginResize = (handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const lockRatio = event.shiftKey
      ? pixelRect.width / Math.max(pixelRect.height, 1)
      : getAspectRatioValue(cropAspectRatio);

    dragStateRef.current = {
      mode: 'resize',
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startRect: pixelRect,
      aspectRatio: lockRatio,
    };
    setIsPointerDragging(true);
  };

  return (
    <div
      ref={overlayRef}
      className={`crop-overlay ${isPointerDragging ? 'dragging' : ''}`}
      style={{
        left: imageBounds.left,
        top: imageBounds.top,
        width: imageBounds.width,
        height: imageBounds.height,
      }}
    >
      <div
        className="crop-selection"
        style={{
          left: `${cropRect.x * 100}%`,
          top: `${cropRect.y * 100}%`,
          width: `${cropRect.width * 100}%`,
          height: `${cropRect.height * 100}%`,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
        }}
        onPointerDown={beginMove}
      >
        <div className="crop-selection-grid" aria-hidden="true" />
        {HANDLE_ORDER.map((handle) => (
          <button
            key={handle}
            type="button"
            className={`crop-handle crop-handle-${handle}`}
            aria-label={`Resize crop ${handle}`}
            onPointerDown={(event) => beginResize(handle, event)}
          />
        ))}
      </div>
    </div>
  );
}

export function getPreviewClipPath(rect: NormalizedCropRect) {
  const top = rect.y * 100;
  const right = 100 - (rect.x + rect.width) * 100;
  const bottom = 100 - (rect.y + rect.height) * 100;
  const left = rect.x * 100;
  return `inset(${top}% ${right}% ${bottom}% ${left}%)`;
}

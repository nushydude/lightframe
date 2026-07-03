import { useCallback, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';

type UseZoomPanOptions = {
  onWheelNext?: () => void;
  onWheelPrev?: () => void;
};

/** Hook for zoom and pan functionality */
export function useZoomPan(
  _containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseZoomPanOptions = {}
) {
  const { onWheelNext, onWheelPrev } = options;
  const {
    zoomMode,
    zoomLevel,
    panX,
    panY,
    setZoomMode,
    setZoomLevel,
    setPan,
    resetZoom,
    zoomIn,
    zoomOut,
  } = useViewerStore();

  const settings = useSettingsStore((s) => s.settings);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  const lastWheelNavigationAtRef = useRef(0);
  const wheelNavigationThrottleMs = 220;

  /** Handle mouse wheel for zoom or navigation */
  const handleWheel = useCallback(
    (e: WheelEvent | ReactWheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (settings.mouseWheelBehavior === 'zoom') {
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newLevel = Math.max(0.1, Math.min(20, zoomLevel * delta));
        setZoomLevel(newLevel);
        return;
      }

      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) {
        return;
      }

      const now = Date.now();
      if (now - lastWheelNavigationAtRef.current < wheelNavigationThrottleMs) {
        return;
      }
      lastWheelNavigationAtRef.current = now;

      if (e.deltaY > 0) {
        onWheelNext?.();
      } else if (e.deltaY < 0) {
        onWheelPrev?.();
      }
    },
    [zoomLevel, settings.mouseWheelBehavior, setZoomLevel, onWheelNext, onWheelPrev]
  );

  /** Start panning */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoomMode === 'custom' || zoomMode === 'actual' || zoomLevel > 1) {
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        panStartRef.current = { x: panX, y: panY };
        e.preventDefault();
      }
    },
    [zoomMode, zoomLevel, panX, panY]
  );

  /** Continue panning */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        setPan(panStartRef.current.x + dx, panStartRef.current.y + dy);
      }
    },
    [isDragging, setPan]
  );

  /** Stop panning */
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  return {
    zoomMode,
    zoomLevel,
    panX,
    panY,
    isDragging,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
    setZoomMode,
    setZoomLevel,
    resetZoom,
    zoomIn,
    zoomOut,
  };
}

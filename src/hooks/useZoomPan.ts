import { useCallback, useRef, useState, useEffect } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';


/** Hook for zoom and pan functionality */
export function useZoomPan(containerRef: React.RefObject<HTMLDivElement | null>) {
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

  /** Handle mouse wheel for zoom or navigation */
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      if (settings.mouseWheelBehavior === 'zoom') {
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newLevel = Math.max(0.1, Math.min(20, zoomLevel * delta));
        setZoomLevel(newLevel);
      }
      // Navigate mode is handled by keyboard shortcuts hook
    },
    [zoomLevel, settings.mouseWheelBehavior, setZoomLevel]
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

  // Attach wheel listener to container
  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
    }
  }, [containerRef, handleWheel]);

  return {
    zoomMode,
    zoomLevel,
    panX,
    panY,
    isDragging,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    setZoomMode,
    setZoomLevel,
    resetZoom,
    zoomIn,
    zoomOut,
  };
}

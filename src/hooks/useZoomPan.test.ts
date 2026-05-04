import { renderHook, act } from '@testing-library/react';
import { useZoomPan } from './useZoomPan';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import React from 'react';

describe('useZoomPan', () => {
  let containerRef: React.RefObject<HTMLDivElement>;

  beforeEach(() => {
    useViewerStore.getState().reset();
    containerRef = { current: document.createElement('div') } as any;
    vi.clearAllMocks();
  });

  it('should handle wheel zoom', () => {
    act(() => {
      useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, mouseWheelBehavior: 'zoom' } });
    });

    renderHook(() => useZoomPan(containerRef));

    const wheelEvent = new WheelEvent('wheel', { deltaY: -100 }); // Zoom in
    act(() => {
      containerRef.current?.dispatchEvent(wheelEvent);
    });

    expect(useViewerStore.getState().zoomLevel).toBeGreaterThan(1);
    expect(useViewerStore.getState().zoomMode).toBe('custom');
  });

  it('should handle dragging (panning)', () => {
    act(() => {
      useViewerStore.getState().setZoomLevel(2); // Must be zoomed in to pan
    });

    const { result } = renderHook(() => useZoomPan(containerRef));

    // Start drag
    act(() => {
      result.current.handleMouseDown({ clientX: 100, clientY: 100, preventDefault: vi.fn() } as any);
    });
    expect(result.current.isDragging).toBe(true);

    // Move
    act(() => {
      result.current.handleMouseMove({ clientX: 150, clientY: 150 } as any);
    });
    expect(useViewerStore.getState().panX).toBe(50);
    expect(useViewerStore.getState().panY).toBe(50);

    // Stop drag
    act(() => {
      result.current.handleMouseUp();
    });
    expect(result.current.isDragging).toBe(false);
  });

  it('should not pan if not zoomed in', () => {
    act(() => {
      useViewerStore.getState().setZoomMode('fit');
    });

    const { result } = renderHook(() => useZoomPan(containerRef));

    act(() => {
      result.current.handleMouseDown({ clientX: 100, clientY: 100, preventDefault: vi.fn() } as any);
    });
    expect(result.current.isDragging).toBe(false);
  });
});

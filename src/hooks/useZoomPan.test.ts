import { renderHook, act } from '@testing-library/react';
import { useZoomPan } from './useZoomPan';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type React from 'react';

describe('useZoomPan', () => {
  let containerRef: React.RefObject<HTMLDivElement>;

  beforeEach(() => {
    useViewerStore.getState().reset();
    containerRef = { current: document.createElement('div') } as any;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should handle wheel zoom in zoom mode', () => {
    act(() => {
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, mouseWheelBehavior: 'zoom' },
      });
    });

    renderHook(() => useZoomPan(containerRef));

    const wheelEvent = new WheelEvent('wheel', { deltaY: -100 }); // Zoom in
    act(() => {
      containerRef.current?.dispatchEvent(wheelEvent);
    });

    expect(useViewerStore.getState().zoomLevel).toBeGreaterThan(1);
    expect(useViewerStore.getState().zoomMode).toBe('custom');
  });

  it('should navigate next/prev in navigate mode', () => {
    const onWheelNext = vi.fn();
    const onWheelPrev = vi.fn();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T00:00:00.000Z'));

    act(() => {
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, mouseWheelBehavior: 'navigate' },
      });
    });

    renderHook(() => useZoomPan(containerRef, { onWheelNext, onWheelPrev }));

    act(() => {
      containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
      vi.advanceTimersByTime(221);
    });
    act(() => {
      containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    });

    expect(onWheelNext).toHaveBeenCalledTimes(1);
    expect(onWheelPrev).toHaveBeenCalledTimes(1);
  });

  it('should ignore mostly horizontal wheel in navigate mode', () => {
    const onWheelNext = vi.fn();
    const onWheelPrev = vi.fn();

    act(() => {
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, mouseWheelBehavior: 'navigate' },
      });
    });

    renderHook(() => useZoomPan(containerRef, { onWheelNext, onWheelPrev }));

    act(() => {
      containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaX: 120, deltaY: 50 }));
    });

    expect(onWheelNext).not.toHaveBeenCalled();
    expect(onWheelPrev).not.toHaveBeenCalled();
  });

  it('should throttle rapid navigate wheel events', () => {
    const onWheelNext = vi.fn();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T00:00:00.000Z'));

    act(() => {
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, mouseWheelBehavior: 'navigate' },
      });
    });

    renderHook(() => useZoomPan(containerRef, { onWheelNext }));

    act(() => {
      containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
      containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    });
    expect(onWheelNext).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(221);
      containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    });
    expect(onWheelNext).toHaveBeenCalledTimes(2);
  });

  it('should handle dragging (panning)', () => {
    act(() => {
      useViewerStore.getState().setZoomLevel(2); // Must be zoomed in to pan
    });

    const { result } = renderHook(() => useZoomPan(containerRef));

    // Start drag
    act(() => {
      result.current.handleMouseDown({
        clientX: 100,
        clientY: 100,
        preventDefault: vi.fn(),
      } as any);
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
      result.current.handleMouseDown({
        clientX: 100,
        clientY: 100,
        preventDefault: vi.fn(),
      } as any);
    });
    expect(result.current.isDragging).toBe(false);
  });
});

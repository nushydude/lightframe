import { useViewerStore } from './viewerStore';
import { describe, it, expect, beforeEach } from 'vitest';

describe('viewerStore', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
  });

  it('should set current image and reset display state', () => {
    useViewerStore.getState().setCurrentImage('test.jpg', 5);
    
    const state = useViewerStore.getState();
    expect(state.currentImagePath).toBe('test.jpg');
    expect(state.currentIndex).toBe(5);
    expect(state.zoomMode).toBe('fit');
    expect(state.zoomLevel).toBe(1);
    expect(state.panX).toBe(0);
  });

  it('should navigate next correctly', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', name: '1', size_bytes: 0, modified_at: null },
        { path: '2.jpg', name: '2', size_bytes: 0, modified_at: null },
        { path: '3.jpg', name: '3', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 0,
    });

    const result = useViewerStore.getState().navigateNext(false);
    expect(result).toBe(true);
    expect(useViewerStore.getState().currentIndex).toBe(1);

    useViewerStore.getState().navigateNext(false);
    const lastResult = useViewerStore.getState().navigateNext(false);
    expect(lastResult).toBe(false);
    expect(useViewerStore.getState().currentIndex).toBe(2);

    const loopResult = useViewerStore.getState().navigateNext(true);
    expect(loopResult).toBe(true);
    expect(useViewerStore.getState().currentIndex).toBe(0);
  });

  it('should zoom in and out with clamping', () => {
    useViewerStore.getState().setZoomLevel(1);
    
    useViewerStore.getState().zoomIn();
    expect(useViewerStore.getState().zoomLevel).toBe(1.25);
    expect(useViewerStore.getState().zoomMode).toBe('custom');

    // Zoom way out
    for (let i = 0; i < 20; i++) useViewerStore.getState().zoomOut();
    expect(useViewerStore.getState().zoomLevel).toBe(0.1);

    // Zoom way in
    for (let i = 0; i < 30; i++) useViewerStore.getState().zoomIn();
    expect(useViewerStore.getState().zoomLevel).toBe(20);
  });

  it('should reset store to initial state', () => {
    useViewerStore.setState({
      currentImagePath: 'some.jpg',
      currentIndex: 10,
      isFullscreen: true,
    });

    useViewerStore.getState().reset();
    
    const state = useViewerStore.getState();
    expect(state.currentImagePath).toBeNull();
    expect(state.currentIndex).toBe(-1);
    expect(state.isFullscreen).toBe(false);
  });
});

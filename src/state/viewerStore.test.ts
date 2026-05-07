import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useViewerStore } from './viewerStore';

const { saveRotatedImageMock, invalidateImageAssetMock } = vi.hoisted(() => ({
  saveRotatedImageMock: vi.fn(),
  invalidateImageAssetMock: vi.fn(),
}));

vi.mock('../services/tauriCommands', () => ({
  saveRotatedImage: saveRotatedImageMock,
}));

vi.mock('../services/imageAssetCache', () => ({
  invalidateImageAsset: invalidateImageAssetMock,
}));

describe('viewerStore', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
    vi.clearAllMocks();
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
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
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

  it('should not change cacheBuster during normal navigation', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 0,
      currentImagePath: '1.jpg',
      cacheBuster: 123,
    });

    useViewerStore.getState().navigateNext(false);
    expect(useViewerStore.getState().cacheBuster).toBe(123);

    useViewerStore.getState().navigatePrev(false);
    expect(useViewerStore.getState().cacheBuster).toBe(123);
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

    const previousGeneration = useViewerStore.getState().loadGeneration;

    useViewerStore.getState().reset();
    
    const state = useViewerStore.getState();
    expect(state.currentImagePath).toBeNull();
    expect(state.currentIndex).toBe(-1);
    expect(state.isFullscreen).toBe(false);
    expect(state.loadGeneration).toBe(previousGeneration + 1);
  });

  it('should invalidate current image and update cacheBuster after saveRotation', async () => {
    saveRotatedImageMock.mockResolvedValue(undefined);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5678);

    useViewerStore.setState({
      currentImagePath: 'test.jpg',
      rotation: 90,
      cacheBuster: 10,
    });

    try {
      await useViewerStore.getState().saveRotation();
    } finally {
      nowSpy.mockRestore();
    }

    expect(saveRotatedImageMock).toHaveBeenCalledWith('test.jpg', 90);
    expect(invalidateImageAssetMock).toHaveBeenCalledWith('test.jpg');
    expect(useViewerStore.getState().rotation).toBe(0);
    expect(useViewerStore.getState().cacheBuster).toBe(5678);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useViewerStore } from './viewerStore';

const {
  confirmMock,
  getImageMetadataMock,
  saveRotatedImageMock,
  overwriteWithCropMock,
  invalidateImageAssetMock,
  invalidateThumbnailMock,
} = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  getImageMetadataMock: vi.fn(),
  saveRotatedImageMock: vi.fn(),
  overwriteWithCropMock: vi.fn(),
  invalidateImageAssetMock: vi.fn(),
  invalidateThumbnailMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: confirmMock,
}));

vi.mock('../services/tauriCommands', () => ({
  getImageMetadata: getImageMetadataMock,
  saveRotatedImage: saveRotatedImageMock,
  overwriteWithCrop: overwriteWithCropMock,
}));

vi.mock('../services/imageAssetCache', () => ({
  invalidateImageAsset: invalidateImageAssetMock,
}));

vi.mock('../services/thumbnailCache', () => ({
  invalidateThumbnail: invalidateThumbnailMock,
}));

describe('viewerStore', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
    useViewerStore.getState().setDefaultZoomMode('fit');
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    getImageMetadataMock.mockResolvedValue({ width: 1200, height: 800 });
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

  it('default zoom mode starts as fit', () => {
    expect(useViewerStore.getState().defaultZoomMode).toBe('fit');
  });

  it("setDefaultZoomMode('fill') affects setCurrentImage", () => {
    useViewerStore.getState().setDefaultZoomMode('fill');
    useViewerStore.getState().setCurrentImage('fill-test.jpg', 0);

    const state = useViewerStore.getState();
    expect(state.currentImagePath).toBe('fill-test.jpg');
    expect(state.zoomMode).toBe('fill');
  });

  it("setDefaultZoomMode('actual') affects setCurrentIndex", () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
    });
    useViewerStore.getState().setDefaultZoomMode('actual');
    useViewerStore.getState().setCurrentIndex(1);

    const state = useViewerStore.getState();
    expect(state.currentIndex).toBe(1);
    expect(state.currentImagePath).toBe('2.jpg');
    expect(state.zoomMode).toBe('actual');
  });

  it('setCurrentIndex can override default zoom mode for projector navigation', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
    });
    useViewerStore.getState().setDefaultZoomMode('fill');
    useViewerStore.getState().setCurrentIndex(1, { zoomMode: 'fit' });

    const state = useViewerStore.getState();
    expect(state.currentIndex).toBe(1);
    expect(state.currentImagePath).toBe('2.jpg');
    expect(state.zoomMode).toBe('fit');
    expect(state.zoomLevel).toBe(1);
  });

  it('keeps slideshow navigation fit to window', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 0,
      currentImagePath: '1.jpg',
      zoomMode: 'custom',
      zoomLevel: 3,
      panX: 120,
      panY: -80,
    });
    useViewerStore.getState().setDefaultZoomMode('actual');

    useViewerStore.getState().startSlideshow();

    expect(useViewerStore.getState().zoomMode).toBe('fit');
    expect(useViewerStore.getState().zoomLevel).toBe(1);
    expect(useViewerStore.getState().panX).toBe(0);
    expect(useViewerStore.getState().panY).toBe(0);

    useViewerStore.getState().setZoomMode('actual');
    useViewerStore.getState().setCurrentIndex(1);

    expect(useViewerStore.getState().currentImagePath).toBe('2.jpg');
    expect(useViewerStore.getState().zoomMode).toBe('fit');
    expect(useViewerStore.getState().zoomLevel).toBe(1);
  });

  it('reset preserves defaultZoomMode for next image open', () => {
    useViewerStore.getState().setDefaultZoomMode('fill');
    useViewerStore.getState().reset();
    useViewerStore.getState().setCurrentImage('after-reset.jpg', 0);

    const state = useViewerStore.getState();
    expect(state.defaultZoomMode).toBe('fill');
    expect(state.zoomMode).toBe('fill');
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

  it('filters the active image list to favorites without losing the full folder list', () => {
    const folderImages = [
      { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
    ];
    useViewerStore.getState().setImages(folderImages);
    useViewerStore.getState().setCurrentIndex(0);
    useViewerStore.getState().syncFavoriteFilter({
      '2.jpg': { favorite: true },
    });

    useViewerStore.getState().setShowOnlyFavorites(true);

    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual(['2.jpg']);
    expect(useViewerStore.getState().allImages.map((image) => image.path)).toEqual([
      '1.jpg',
      '2.jpg',
      '3.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('2.jpg');

    useViewerStore.getState().setShowOnlyFavorites(false);
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      '1.jpg',
      '2.jpg',
      '3.jpg',
    ]);
    expect(useViewerStore.getState().currentImagePath).toBe('1.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(0);
  });

  it('returns to the pre-filter image when favorites-only is disabled', () => {
    const folderImages = [
      { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
    ];

    useViewerStore.getState().setImages(folderImages);
    useViewerStore.getState().setCurrentIndex(2);
    useViewerStore.getState().syncFavoriteFilter({
      '2.jpg': { favorite: true },
    });

    useViewerStore.getState().setShowOnlyFavorites(true);
    expect(useViewerStore.getState().currentImagePath).toBe('2.jpg');

    useViewerStore.getState().setShowOnlyFavorites(false);
    expect(useViewerStore.getState().currentImagePath).toBe('3.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(2);
  });

  it('refreshes the favorites filter when curation changes', () => {
    useViewerStore.getState().setImages([
      { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
    ]);
    useViewerStore.getState().syncFavoriteFilter({
      '1.jpg': { favorite: true },
      '2.jpg': { favorite: true },
    });
    useViewerStore.getState().setShowOnlyFavorites(true);
    useViewerStore.getState().setCurrentIndex(1);

    useViewerStore.getState().syncFavoriteFilter({
      '1.jpg': { favorite: true },
    });

    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual(['1.jpg']);
    expect(useViewerStore.getState().currentImagePath).toBe('1.jpg');
  });

  it('sorts curated favorites by highest rating and most recent review first', () => {
    useViewerStore.getState().setImages([
      { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
    ]);
    useViewerStore.getState().syncFavoriteFilter({
      '1.jpg': { favorite: true, rating: 4, updated_at: 100 },
      '2.jpg': { favorite: true, rating: 5, updated_at: 90 },
      '3.jpg': { favorite: true, rating: 4, updated_at: 200 },
    });

    useViewerStore.getState().setCurationFilter('favorites');

    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
      '2.jpg',
      '3.jpg',
      '1.jpg',
    ]);
  });

  it('filters images to 4+ star items and returns to the prior image when cleared', () => {
    useViewerStore.getState().setImages([
      { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
    ]);
    useViewerStore.getState().setCurrentIndex(2);
    useViewerStore.getState().syncFavoriteFilter({
      '1.jpg': { rating: 4 },
      '2.jpg': { favorite: true, rating: 5 },
    });

    useViewerStore.getState().setCurationFilter('rated4');

    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual(['2.jpg', '1.jpg']);
    expect(useViewerStore.getState().currentImagePath).toBe('1.jpg');
    expect(useViewerStore.getState().curationFilter).toBe('rated4');

    useViewerStore.getState().setCurationFilter('all');

    expect(useViewerStore.getState().currentImagePath).toBe('3.jpg');
    expect(useViewerStore.getState().currentIndex).toBe(2);
  });

  it('refreshes unreviewed filtering when curation changes', () => {
    useViewerStore.getState().setImages([
      { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
    ]);
    useViewerStore.getState().setCurrentIndex(0);
    useViewerStore.getState().syncFavoriteFilter({
      '2.jpg': { rating: 5, favorite: true },
    });

    useViewerStore.getState().setCurationFilter('unreviewed');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual(['1.jpg', '3.jpg']);

    useViewerStore.getState().syncFavoriteFilter({
      '1.jpg': { rating: 4, favorite: true },
      '2.jpg': { rating: 5, favorite: true },
    });

    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual(['3.jpg']);
    expect(useViewerStore.getState().currentImagePath).toBe('3.jpg');
  });

  it('removes multiple images in one pass while preserving the nearest current image', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '4.jpg', file_name: '4', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      allImages: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '4.jpg', file_name: '4', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 1,
      currentImagePath: '2.jpg',
      pendingEditsByPath: {
        '1.jpg': {
          rotationDegrees: 90,
          cropRect: null,
          pendingCropPreview: null,
          updatedAt: 1,
          history: [],
        },
        '3.jpg': {
          rotationDegrees: 180,
          cropRect: null,
          pendingCropPreview: null,
          updatedAt: 2,
          history: [],
        },
      },
    });

    useViewerStore.getState().removeImagesByPaths(['1.jpg', '2.jpg', '3.jpg']);

    const state = useViewerStore.getState();
    expect(state.images.map((image) => image.path)).toEqual(['4.jpg']);
    expect(state.allImages.map((image) => image.path)).toEqual(['4.jpg']);
    expect(state.currentImagePath).toBe('4.jpg');
    expect(state.currentIndex).toBe(0);
    expect(state.pendingEditsByPath).toEqual({});
    expect(invalidateImageAssetMock).toHaveBeenCalledTimes(3);
    expect(invalidateThumbnailMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the full list visible when favorites-only has no matches', () => {
    useViewerStore.getState().setImages([
      { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
    ]);

    useViewerStore.getState().setShowOnlyFavorites(true);

    expect(useViewerStore.getState().showOnlyFavorites).toBe(false);
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual(['1.jpg', '2.jpg']);
    expect(useViewerStore.getState().errorMessage).toContain('No favorite images');
  });

  it('keeps the full list visible when a curation filter has no matches', () => {
    useViewerStore.getState().setImages([
      { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
    ]);

    useViewerStore.getState().setCurationFilter('rated5');

    expect(useViewerStore.getState().curationFilter).toBe('all');
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual(['1.jpg', '2.jpg']);
    expect(useViewerStore.getState().errorMessage).toContain('No 5-star images');
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
    expect(invalidateThumbnailMock).toHaveBeenCalledWith('test.jpg');
    expect(useViewerStore.getState().rotation).toBe(0);
    expect(useViewerStore.getState().cacheBuster).toBe(5678);
  });

  it('manages crop mode and preview state', () => {
    useViewerStore.getState().enterCropMode();
    expect(useViewerStore.getState().isCropMode).toBe(true);
    expect(useViewerStore.getState().cropRect).not.toBeNull();

    useViewerStore.getState().updateCropRect({
      x: 0.2,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    });
    useViewerStore.getState().applyCropPreview();

    const state = useViewerStore.getState();
    expect(state.isCropMode).toBe(false);
    expect(state.pendingCropPreview).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    });
  });

  it('tracks marked images independently from navigation state', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
    });

    useViewerStore.getState().toggleMarkedPath('1.jpg');
    useViewerStore.getState().toggleMarkedPath('2.jpg');
    expect(useViewerStore.getState().markedPaths).toEqual(['1.jpg', '2.jpg']);

    useViewerStore.getState().toggleMarkedPath('1.jpg');
    expect(useViewerStore.getState().markedPaths).toEqual(['2.jpg']);

    useViewerStore.getState().markAllVisibleImages();
    expect(useViewerStore.getState().markedPaths).toEqual(['1.jpg', '2.jpg']);

    useViewerStore.getState().clearMarkedPaths();
    expect(useViewerStore.getState().markedPaths).toEqual([]);
  });

  it('restores per-image pending edits when navigating away and back', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 0,
      currentImagePath: '1.jpg',
    });

    useViewerStore.getState().rotateClockwise();
    useViewerStore.getState().enterCropMode();
    useViewerStore.getState().updateCropRect({
      x: 0.2,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    });
    useViewerStore.getState().applyCropPreview();
    useViewerStore.getState().setCurrentIndex(1);

    expect(useViewerStore.getState().rotation).toBe(0);
    expect(useViewerStore.getState().pendingCropPreview).toBeNull();

    useViewerStore.getState().setCurrentIndex(0);

    const state = useViewerStore.getState();
    expect(state.rotation).toBe(90);
    expect(state.isCropMode).toBe(false);
    expect(state.cropRect).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    });
    expect(state.pendingCropPreview).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    });
  });

  it('clears crop state when switching to grid mode', () => {
    useViewerStore.getState().enterCropMode();
    useViewerStore.getState().applyCropPreview();

    useViewerStore.getState().setViewMode('grid');

    expect(useViewerStore.getState().isCropMode).toBe(false);
    expect(useViewerStore.getState().cropRect).toBeNull();
    expect(useViewerStore.getState().pendingCropPreview).toBeNull();
  });

  it('clears current-image edits separately from clearing all pending edits', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 0,
      currentImagePath: '1.jpg',
    });

    useViewerStore.getState().rotateClockwise();
    useViewerStore.getState().setCurrentIndex(1);
    useViewerStore.getState().rotateClockwise();

    useViewerStore.getState().clearPendingEdits('1.jpg');
    expect(useViewerStore.getState().pendingEditsByPath['1.jpg']).toBeUndefined();
    expect(useViewerStore.getState().pendingEditsByPath['2.jpg']).toBeDefined();

    useViewerStore.getState().clearAllPendingEdits();
    expect(useViewerStore.getState().pendingEditsByPath).toEqual({});
    expect(useViewerStore.getState().rotation).toBe(0);
  });

  it('clears pending edits after a successful commit and keeps them after a failure', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(9999);
    useViewerStore.setState({
      currentImagePath: 'test.jpg',
      currentIndex: 0,
      images: [
        { path: 'test.jpg', file_name: 'test', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
    });
    useViewerStore.getState().rotateClockwise();

    try {
      saveRotatedImageMock.mockResolvedValueOnce(undefined);
      await useViewerStore.getState().commitPendingEdits('test.jpg');

      expect(saveRotatedImageMock).toHaveBeenCalledWith('test.jpg', 90);
      expect(useViewerStore.getState().pendingEditsByPath['test.jpg']).toBeUndefined();
      expect(useViewerStore.getState().rotation).toBe(0);
      expect(useViewerStore.getState().cacheBuster).toBe(9999);

      useViewerStore.getState().rotateClockwise();
      saveRotatedImageMock.mockRejectedValueOnce(new Error('nope'));
      await useViewerStore.getState().commitPendingEdits('test.jpg');

      expect(useViewerStore.getState().pendingEditsByPath['test.jpg']).toBeDefined();
      expect(useViewerStore.getState().rotation).toBe(90);
      expect(useViewerStore.getState().errorMessage).toContain('Failed to save edits');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses source image metadata dimensions when committing a crop', async () => {
    useViewerStore.setState({
      currentImagePath: 'test.jpg',
      currentIndex: 0,
      images: [
        { path: 'test.jpg', file_name: 'test', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      pendingEditsByPath: {
        'test.jpg': {
          rotationDegrees: 0,
          cropRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
          pendingCropPreview: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
          updatedAt: 1,
          history: [],
        },
      },
      cropRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
      pendingCropPreview: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
    });

    await useViewerStore.getState().commitPendingEdits('test.jpg');

    expect(getImageMetadataMock).toHaveBeenCalledWith('test.jpg');
    expect(overwriteWithCropMock).toHaveBeenCalledWith(
      'test.jpg',
      {
        x: 120,
        y: 160,
        width: 600,
        height: 200,
      },
      0
    );
  });

  it('enters compare mode using current image as primary and adjacent image as secondary', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 1,
      currentImagePath: '2.jpg',
    });

    const didEnter = useViewerStore.getState().enterCompareMode();
    expect(didEnter).toBe(true);

    const state = useViewerStore.getState();
    expect(state.viewMode).toBe('compare');
    expect(state.comparePrimaryIndex).toBe(1);
    expect(state.compareSecondaryIndex).toBe(2);
    expect(state.compareFocusedPane).toBe('secondary');
  });

  it('blocks compare mode for single-image folders', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 0,
      currentImagePath: '1.jpg',
    });

    const didEnter = useViewerStore.getState().enterCompareMode();
    expect(didEnter).toBe(false);
    expect(useViewerStore.getState().viewMode).toBe('viewer');
  });

  it('navigates compare candidates, promotes focused pane, and exits compare mode', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 1,
      currentImagePath: '2.jpg',
    });
    useViewerStore.getState().enterCompareMode();

    useViewerStore.getState().switchCompareFocus();
    expect(useViewerStore.getState().compareFocusedPane).toBe('primary');

    expect(useViewerStore.getState().moveCompareFocusedCandidate(-1)).toBe(true);
    expect(useViewerStore.getState().comparePrimaryIndex).toBe(0);
    expect(useViewerStore.getState().currentIndex).toBe(0);

    useViewerStore.getState().switchCompareFocus();
    expect(useViewerStore.getState().compareFocusedPane).toBe('secondary');

    expect(useViewerStore.getState().promoteFocusedComparePane()).toBe(true);
    expect(useViewerStore.getState().comparePrimaryIndex).toBe(2);
    expect(useViewerStore.getState().compareSecondaryIndex).toBe(0);
    expect(useViewerStore.getState().currentIndex).toBe(2);

    useViewerStore.getState().exitCompareMode();
    expect(useViewerStore.getState().viewMode).toBe('viewer');
    expect(useViewerStore.getState().currentIndex).toBe(2);
    expect(useViewerStore.getState().currentImagePath).toBe('3.jpg');
  });

  it('keeps compare indices valid as the image list changes', () => {
    useViewerStore.setState({
      images: [
        { path: '1.jpg', file_name: '1', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
        { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
      ],
      currentIndex: 1,
      currentImagePath: '2.jpg',
    });
    useViewerStore.getState().enterCompareMode();

    useViewerStore.getState().setImages([
      { path: '3.jpg', file_name: '3', extension: 'jpg', size_bytes: 0, modified_at: null },
      { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
    ]);
    expect(useViewerStore.getState().comparePrimaryIndex).toBe(1);
    expect(useViewerStore.getState().compareSecondaryIndex).toBe(0);

    useViewerStore
      .getState()
      .setImages([
        { path: '2.jpg', file_name: '2', extension: 'jpg', size_bytes: 0, modified_at: null },
      ]);
    expect(useViewerStore.getState().viewMode).toBe('viewer');
    expect(useViewerStore.getState().compareSecondaryIndex).toBe(-1);
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppViewerSurface } from './AppViewerSurface';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import { setReviewDecisionForCurrentImage } from '../services/reviewDecisionActions';
import { DEFAULT_SETTINGS } from '../types/settings';

const { writeImageCurationMock } = vi.hoisted(() => ({
  writeImageCurationMock: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock('../services/tauriCommands', () => ({
  readCurationMetadata: vi.fn(async () => ({})),
  readCurationMetadataForPaths: vi.fn(async () => ({})),
  writeImageCuration: writeImageCurationMock,
  writeImageCurationBatch: vi.fn((): Promise<void> => Promise.resolve()),
  resetImageReviewDecision: vi.fn((): Promise<void> => Promise.resolve()),
  clearImageCuration: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock('./ImageCanvas', () => ({
  ImageCanvas: () => <div data-testid="image-canvas" />,
}));

vi.mock('./ViewerChrome', () => ({
  ViewerChrome: () => <div data-testid="viewer-chrome" />,
}));

vi.mock('./ThumbnailStrip', () => ({
  ThumbnailStrip: () => <div data-testid="thumbnail-strip" />,
}));

vi.mock('./LazySurface', () => ({
  LazySurface: ({ label }: { label: string }) => <div>{label}</div>,
}));

function image(path: string) {
  return { path, file_name: path, extension: 'jpg', size_bytes: 0, modified_at: null };
}

const defaultProps = {
  isSecondary: false,
  showThumbnails: false,
  isSlideshowActive: false,
  onCloseProjectorWindow: vi.fn(),
  onNext: vi.fn(),
  onPrev: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenFolder: vi.fn(),
  onOpenRecentFolder: vi.fn(),
  onRefreshFolder: vi.fn(),
  onGoHome: vi.fn(),
  onFirst: vi.fn(),
  onLast: vi.fn(),
  onStartSlideshow: vi.fn(),
  onStopSlideshow: vi.fn(),
  onTogglePause: vi.fn(),
  onExitGridView: vi.fn(async () => true),
};

function SurfaceHarness() {
  const currentImagePath = useViewerStore((state) => state.currentImagePath);
  const viewMode = useViewerStore((state) => state.viewMode);
  const isSlideshowActive = useViewerStore((state) => state.isSlideshowActive);

  return (
    <AppViewerSurface
      {...defaultProps}
      currentImagePath={currentImagePath}
      viewMode={viewMode}
      isSlideshowActive={isSlideshowActive}
    />
  );
}

describe('AppViewerSurface filtered empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useViewerStore.getState().reset();
    useCurationStore.setState({
      curationByPath: {},
      favoritePaths: new Set(),
      mutationStatus: 'idle',
      mutationError: null,
      failedOperation: null,
      errorDismissed: false,
    });
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: false },
    });
  });

  it.each([
    ['viewer', 'unreviewed', 'No unreviewed found in the current folder.'],
    ['viewer', 'keep', 'No kept found in the current folder.'],
    ['viewer', 'reject', 'No rejected found in the current folder.'],
    ['grid', 'unreviewed', 'No unreviewed found in the current folder.'],
    ['grid', 'keep', 'No kept found in the current folder.'],
    ['grid', 'reject', 'No rejected found in the current folder.'],
  ] as const)(
    'renders before generic empty state in %s mode for an empty %s filter',
    (viewMode, curationFilter, message) => {
      const allImages = [image('1.jpg'), image('2.jpg')];
      useViewerStore.setState({
        allImages,
        images: [],
        currentImagePath: null,
        currentIndex: -1,
        viewMode,
        curationFilter,
      });

      render(<SurfaceHarness />);

      expect(screen.getByRole('status')).toHaveTextContent(message);
      fireEvent.click(screen.getByRole('button', { name: 'Show all images' }));
      expect(useViewerStore.getState().curationFilter).toBe('all');
      expect(useViewerStore.getState().images.map((entry) => entry.path)).toEqual([
        '1.jpg',
        '2.jpg',
      ]);
    }
  );

  it('renders filtered empty after the last unreviewed image is reviewed and removed', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    useViewerStore.getState().setImages([image('1.jpg')]);
    useViewerStore.getState().setCurrentIndex(0);
    useViewerStore.getState().setCurationFilter('unreviewed');

    render(<SurfaceHarness />);
    expect(screen.getByTestId('image-canvas')).toBeInTheDocument();

    await act(async () => {
      await setReviewDecisionForCurrentImage('keep');
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'No unreviewed found in the current folder.'
      );
    });
    expect(screen.getByRole('button', { name: 'Show all images' })).toBeInTheDocument();
  });
});

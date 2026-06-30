import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { ViewerChrome } from './ViewerChrome';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useEditQueueStore } from '../state/editQueueStore';
import { useSettingsStore } from '../state/settingsStore';
import { DEFAULT_SETTINGS } from '../types/settings';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import * as tauriCommands from '../services/tauriCommands';
import { useToastStore } from '../state/toastStore';

const projectorState = vi.hoisted(() => ({
  isProjectorOpen: false,
  refreshProjectorState: vi.fn(),
}));

vi.mock('../hooks/useProjectorState', () => ({
  useProjectorState: () => ({
    isProjectorOpen: projectorState.isProjectorOpen,
    refreshProjectorState: projectorState.refreshProjectorState,
  }),
}));

describe('ViewerChrome', () => {
  const defaultProps = {
    onOpenFile: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenRecentFolder: vi.fn(),
    onRefreshFolder: vi.fn(),
    onGoHome: vi.fn(),
    onFirst: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onStartSlideshow: vi.fn(),
    onStopSlideshow: vi.fn(),
    onTogglePause: vi.fn(),
  };

  beforeEach(() => {
    useViewerStore.getState().reset();
    useCurationStore.setState({ curationByPath: {}, isLoaded: false });
    useEditQueueStore.getState().reset();
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...DEFAULT_SETTINGS,
        promptProjectorGridOnOpen: true,
        openProjectorInGridView: false,
      },
    }));
    projectorState.isProjectorOpen = false;
    projectorState.refreshProjectorState.mockReset();
    vi.clearAllMocks();
    vi.spyOn(tauriCommands, 'getImageMetadata').mockResolvedValue({
      width: 1200,
      height: 800,
      file_size_bytes: 1000,
      format: 'JPEG',
    });
    useToastStore.getState().clearToasts();
    document.body.innerHTML = '';
    window.localStorage.clear();
  });

  it('should not render if no image is open', () => {
    const { container } = render(<ViewerChrome {...defaultProps} />);
    expect(container.firstChild).toBeNull();
  });

  it('should render file name and counter when image is open', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/other.jpg',
          file_name: 'other.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(screen.getByText('photo.jpg')).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
  });

  it('shows only a star for favorites without a rating', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });
    useCurationStore.setState({
      curationByPath: {
        'C:/Images/photo.jpg': {
          path: 'C:/Images/photo.jpg',
          favorite: true,
          rating: 0,
          updated_at: 1,
        },
      },
      isLoaded: true,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const topBarLeft = container.querySelector('.top-bar-left');

    expect(topBarLeft?.textContent).toContain('★');
    expect(topBarLeft?.textContent).not.toContain('0/5');
  });

  it('should call onNext when next button is clicked', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo.jpg',
      images: [
        {
          path: 'C:/photo1.jpg',
          file_name: 'photo1.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/photo2.jpg',
          file_name: 'photo2.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
    });

    render(<ViewerChrome {...defaultProps} />);

    const nextBtn = screen.getAllByLabelText('Next image')[0];
    fireEvent.click(nextBtn);

    expect(defaultProps.onNext).toHaveBeenCalledTimes(1);
  });

  it('should call onFirst when first-image button is clicked', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo2.jpg',
      images: [
        {
          path: 'C:/photo1.jpg',
          file_name: 'photo1.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/photo2.jpg',
          file_name: 'photo2.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
      currentIndex: 1,
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('First image'));

    expect(defaultProps.onFirst).toHaveBeenCalledTimes(1);
  });

  it('keeps next image beside previous before the slideshow control', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo1.jpg',
      images: [
        {
          path: 'C:/photo1.jpg',
          file_name: 'photo1.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/photo2.jpg',
          file_name: 'photo2.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const toolbarIds = Array.from(container.querySelectorAll('.bottom-controls button')).map(
      (button) => button.id
    );

    expect(toolbarIds.indexOf('btn-ctrl-prev')).toBeLessThan(toolbarIds.indexOf('btn-ctrl-next'));
    expect(toolbarIds.indexOf('btn-ctrl-next')).toBeLessThan(
      toolbarIds.indexOf('btn-start-slideshow')
    );
  });

  it('resets zoom to fit when clicking the zoom display text', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo.jpg',
      zoomMode: 'custom',
      zoomLevel: 1.75,
      panX: 24,
      panY: -12,
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Reset zoom to fit'));

    expect(useViewerStore.getState()).toMatchObject({
      zoomMode: 'fit',
      zoomLevel: 1,
      panX: 0,
      panY: 0,
    });
  });

  it('should call onGoHome when the home button is clicked', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg' });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Back to landing page'));

    expect(defaultProps.onGoHome).toHaveBeenCalledTimes(1);
  });

  it('should refresh folder button be enabled when folder is open', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    const refreshButton = screen.getByLabelText('Refresh folder');
    expect(refreshButton).toBeEnabled();

    fireEvent.click(refreshButton);
    expect(defaultProps.onRefreshFolder).toHaveBeenCalledTimes(1);
  });

  it('opens recent folders from the overflow menu', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        recentFolders: [{ path: 'D:/Shoots/May', label: 'May', openedAt: 100 }],
      },
    }));

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByLabelText('Open recent folder'));
    fireEvent.click(screen.getByText('May'));

    expect(defaultProps.onOpenRecentFolder).toHaveBeenCalledWith('D:/Shoots/May', undefined);
  });

  it('opens recent folders into a saved preset from the overflow menu', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        recentFolders: [{ path: 'D:/Shoots/May', label: 'May', openedAt: 100 }],
        savedViewPresets: ['rated4'],
      },
    }));

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByLabelText('Open recent folder'));
    const presetButtons = screen.getAllByRole('button', { name: '4+ Stars' });
    fireEvent.click(presetButtons[presetButtons.length - 1] as HTMLButtonElement);

    expect(defaultProps.onOpenRecentFolder).toHaveBeenCalledWith('D:/Shoots/May', 'rated4');
  });

  it('pins overflow actions into the top bar', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });

    const { container } = render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByLabelText('Pin Refresh'));

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.pinnedToolbarActions).toContain('refresh');
    });

    expect(container.querySelector('#btn-pinned-refresh')).toBeTruthy();
  });

  it('shows a disabled compare button when fewer than two images are loaded', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo.jpg',
      images: [
        {
          path: 'C:/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(screen.getByLabelText('Toggle compare view')).toBeDisabled();
  });

  it('should toggle fullscreen when button is clicked', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg' });
    const mockWindow = getCurrentWindow();

    render(<ViewerChrome {...defaultProps} />);

    const fsBtn = screen.getByLabelText('Toggle fullscreen');
    await act(async () => {
      fireEvent.click(fsBtn);
    });

    await waitFor(() => {
      expect(mockWindow.setFullscreen).toHaveBeenCalledWith(true);
    });
    expect(useViewerStore.getState().isFullscreen).toBe(true);
  });

  it('should show slideshow indicator when active', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo.jpg',
      isSlideshowActive: true,
      isSlideshowPaused: false,
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(screen.getByText(/▶ Slideshow/i)).toBeInTheDocument();
  });

  it('shows stop slideshow controls when slideshow is active', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo1.jpg',
      isSlideshowActive: true,
      isSlideshowPaused: false,
      images: [
        {
          path: 'C:/photo1.jpg',
          file_name: 'photo1.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/photo2.jpg',
          file_name: 'photo2.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(container.querySelector('#btn-stop-slideshow') as HTMLButtonElement);

    expect(defaultProps.onStopSlideshow).toHaveBeenCalledTimes(1);
    expect(screen.getAllByLabelText('Stop slideshow')).toHaveLength(2);
  });

  it('announces the current slideshow pause or resume action', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo1.jpg',
      isSlideshowActive: true,
      isSlideshowPaused: false,
      images: [
        {
          path: 'C:/photo1.jpg',
          file_name: 'photo1.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/photo2.jpg',
          file_name: 'photo2.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    const { rerender } = render(<ViewerChrome {...defaultProps} />);

    expect(screen.getAllByLabelText('Pause slideshow')).toHaveLength(2);

    useViewerStore.setState({ isSlideshowPaused: true });
    rerender(<ViewerChrome {...defaultProps} />);

    expect(screen.getAllByLabelText('Resume slideshow')).toHaveLength(2);
  });

  it('shows a top-bar slideshow button', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo.jpg',
      images: [
        {
          path: 'C:/photo1.jpg',
          file_name: 'photo1.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/photo2.jpg',
          file_name: 'photo2.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(container.querySelector('#btn-top-slideshow') as HTMLButtonElement);

    expect(defaultProps.onStartSlideshow).toHaveBeenCalledTimes(1);
  });

  it('does not mount compact bottom controls unless the compact breakpoint matches', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo.jpg',
      images: [
        {
          path: 'C:/photo1.jpg',
          file_name: 'photo1.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/photo2.jpg',
          file_name: 'photo2.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(screen.queryByLabelText('More controls')).not.toBeInTheDocument();
  });

  it('applies a curation filter from the toolbar menu', () => {
    const folderImages = [
      {
        path: 'C:/photo1.jpg',
        file_name: 'photo1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1',
      },
      {
        path: 'C:/photo2.jpg',
        file_name: 'photo2.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2',
      },
    ];
    useViewerStore.getState().setImages(folderImages);
    useViewerStore.getState().setCurrentIndex(0);
    useViewerStore.getState().syncFavoriteFilter({
      'C:/photo2.jpg': { favorite: true },
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Filter images'));
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));

    expect(useViewerStore.getState().showOnlyFavorites).toBe(true);
    expect(useViewerStore.getState().images.map((image) => image.path)).toEqual(['C:/photo2.jpg']);
  });

  it('should call zoomIn and zoomOut from store', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg' });
    const spyIn = vi.spyOn(useViewerStore.getState(), 'zoomIn');
    const spyOut = vi.spyOn(useViewerStore.getState(), 'zoomOut');

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(spyIn).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Zoom out'));
    expect(spyOut).toHaveBeenCalled();
  });

  it('shows unsaved edit indicators when the current image has pending edits', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      pendingEditsByPath: {
        'C:/Images/photo.jpg': {
          rotationDegrees: 90,
          cropRect: null,
          pendingCropPreview: null,
          updatedAt: 1,
          history: [],
        },
      },
      rotation: 90,
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(screen.getByText('Unsaved edits')).toBeInTheDocument();
    expect(screen.getByLabelText('Reset pending edits')).toBeInTheDocument();
    expect(screen.getByLabelText('Save pending edits')).toBeInTheDocument();
  });

  it('toggles the marked state from the top bar', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Mark current image'));
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/photo.jpg']);

    fireEvent.click(screen.getByLabelText('Unmark current image'));
    expect(useViewerStore.getState().markedPaths).toEqual([]);
  });

  it('preserves marked paths when bulk delete is canceled', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/one.jpg',
      images: [
        {
          path: 'C:/Images/one.jpg',
          file_name: 'one.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/two.jpg',
          file_name: 'two.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/one.jpg', 'C:/Images/two.jpg'],
    });
    vi.mocked(confirm).mockResolvedValue(false);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const bulkToolbar = screen.getByRole('toolbar', { name: 'Marked image actions' });
    await act(async () => {
      fireEvent.click(within(bulkToolbar).getByRole('button', { name: 'Delete' }));
    });

    expect(useViewerStore.getState().markedPaths).toEqual([
      'C:/Images/one.jpg',
      'C:/Images/two.jpg',
    ]);
  });

  it('keeps failed marked items selected after a partial bulk delete failure', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/one.jpg',
      images: [
        {
          path: 'C:/Images/one.jpg',
          file_name: 'one.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/two.jpg',
          file_name: 'two.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/one.jpg', 'C:/Images/two.jpg'],
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.spyOn(tauriCommands, 'moveToTrash')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('locked'));

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const bulkToolbar = screen.getByRole('toolbar', { name: 'Marked image actions' });
    await act(async () => {
      fireEvent.click(within(bulkToolbar).getByRole('button', { name: 'Delete' }));
    });

    await waitFor(() => {
      expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
        'C:/Images/two.jpg',
      ]);
    });
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/two.jpg']);
  });

  it('opens a context menu with shortcut hints on right click', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const imageCanvas = document.createElement('div');
    imageCanvas.className = 'image-canvas';
    container.appendChild(imageCanvas);

    fireEvent.contextMenu(imageCanvas);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveTextContent('Ctrl+Shift+C');
    expect(menu).toHaveTextContent('Delete');
  });

  it('keeps the context menu action clickable through pointerdown', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const imageCanvas = document.createElement('div');
    imageCanvas.className = 'image-canvas';
    container.appendChild(imageCanvas);

    fireEvent.contextMenu(imageCanvas);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    const markAction = within(menu).getByRole('menuitem', { name: /Mark Current Image/i });

    fireEvent.pointerDown(markAction);
    fireEvent.click(markAction);

    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/photo.jpg']);
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Image actions' })).not.toBeInTheDocument();
    });
  });

  it('keeps context menu actions pinned to the image that was right-clicked', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const imageCanvas = document.createElement('div');
    imageCanvas.className = 'image-canvas';
    container.appendChild(imageCanvas);

    fireEvent.contextMenu(imageCanvas);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    useViewerStore.getState().setCurrentIndex(1);

    const markAction = within(menu).getByRole('menuitem', { name: /Mark Current Image/i });
    fireEvent.click(markAction);

    expect(useViewerStore.getState().currentImagePath).toBe('C:/Images/next.jpg');
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/photo.jpg']);
  });

  it('binds thumbnail-strip context menu actions to the clicked thumbnail path', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const thumbnailStrip = document.createElement('div');
    thumbnailStrip.className = 'thumbnail-strip';
    const thumbnailItem = document.createElement('div');
    thumbnailItem.className = 'thumbnail-item';
    thumbnailItem.setAttribute('data-image-path', 'C:/Images/next.jpg');
    thumbnailStrip.appendChild(thumbnailItem);
    container.appendChild(thumbnailStrip);

    fireEvent.contextMenu(thumbnailItem);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    const markAction = within(menu).getByRole('menuitem', { name: /Mark Current Image/i });
    fireEvent.click(markAction);

    expect(useViewerStore.getState().currentImagePath).toBe('C:/Images/photo.jpg');
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/next.jpg']);
  });

  it('keeps marked actions collapsed until opened', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/photo.jpg'],
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Marked image actions' })).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Marked image actions' })).not.toBeInTheDocument();
  });

  it('closes the viewer bulk transfer menu when clicking outside', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/photo.jpg'],
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const bulkToolbar = screen.getByRole('toolbar', { name: 'Marked image actions' });
    const bulkCopyMenu = bulkToolbar.querySelector('details') as HTMLDetailsElement;
    const bulkCopySummary = bulkCopyMenu.querySelector('summary') as HTMLElement;

    fireEvent.click(bulkCopySummary);
    expect(bulkCopyMenu.open).toBe(true);

    fireEvent.pointerDown(document.body);
    expect(bulkCopyMenu.open).toBe(false);
  });

  it('does nothing when save cropped copy dialog is canceled', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      isCropMode: true,
      cropRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
    });
    vi.mocked(save).mockResolvedValue(null);
    const saveCopySpy = vi.spyOn(tauriCommands, 'saveCroppedCopy');

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save cropped copy'));
    });

    expect(saveCopySpy).not.toHaveBeenCalled();
  });

  it('saves a high-quality scaled copy with export adjustments', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
      imageSmoothing: 20,
      imageSharpening: 30,
    });
    vi.mocked(save).mockResolvedValue('C:/Images/photo-scaled.jpg');
    const scaleSpy = vi.spyOn(tauriCommands, 'saveScaledCopy').mockResolvedValue(undefined);

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Scaled export quality'));
    fireEvent.change(screen.getByLabelText('Scaled copy width'), {
      target: { value: '600' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(scaleSpy).toHaveBeenCalledWith(
      'C:/Images/photo.jpg',
      'C:/Images/photo-scaled.jpg',
      600,
      400,
      20,
      30
    );
  });

  it('queues a high-quality scaled copy without running it immediately', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
      imageSmoothing: 20,
      imageSharpening: 30,
    });
    vi.mocked(save).mockResolvedValue('C:/Images/photo-scaled.jpg');
    const scaleSpy = vi.spyOn(tauriCommands, 'saveScaledCopy').mockResolvedValue(undefined);

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Scaled export quality'));
    fireEvent.change(screen.getByLabelText('Scaled copy width'), {
      target: { value: '600' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    });

    expect(scaleSpy).not.toHaveBeenCalled();
    expect(useEditQueueStore.getState().jobs).toMatchObject([
      {
        kind: 'scaled-copy',
        sourcePath: 'C:/Images/photo.jpg',
        outputPath: 'C:/Images/photo-scaled.jpg',
        width: 600,
        height: 400,
        smoothing: 20,
        sharpening: 30,
        status: 'queued',
      },
    ]);
    expect(screen.getByRole('region', { name: 'Editing queue' })).toBeInTheDocument();
  });

  it('rejects queued exports that reuse an active output path', async () => {
    useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/other.jpg',
      outputPath: 'C:/Images/photo-scaled.jpg',
      width: 600,
      height: 400,
      smoothing: 0,
      sharpening: 0,
    });
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });
    vi.mocked(save).mockResolvedValue('C:/Images/photo-scaled.jpg');

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Scaled export quality'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    });

    expect(useEditQueueStore.getState().jobs).toHaveLength(1);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Editing Queue',
        kind: 'error',
        message: expect.stringContaining('active queued export'),
      })
    );
  });

  it('shows a small debounced quality preview sample without filtering the main canvas', async () => {
    vi.useFakeTimers();
    try {
      useViewerStore.setState({
        currentImagePath: 'C:/Images/photo.jpg',
        images: [
          {
            path: 'C:/Images/photo.jpg',
            file_name: 'photo.jpg',
            extension: 'jpg',
            size_bytes: 100,
            modified_at: '1',
          },
        ],
        currentIndex: 0,
        imageSmoothing: 20,
        imageSharpening: 30,
      });

      const image = document.createElement('img');
      image.src = 'asset://localhost/photo.jpg';
      Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
      Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
      const container = document.createElement('div');
      container.className = 'image-canvas';
      container.appendChild(image);
      document.body.appendChild(container);

      render(<ViewerChrome {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Scaled export quality'));
      });

      const sample = screen.getByLabelText('Approximate scaled export preview sample');
      const sampleImage = sample.querySelector('img') as HTMLImageElement;
      expect(sampleImage.getAttribute('src')).toContain('photo.jpg');
      expect(sampleImage.getAttribute('style')).toContain('blur(0.25px)');
      expect(image.style.filter).toBe('');

      fireEvent.change(screen.getByLabelText('Export smoothing'), {
        target: { value: '80' },
      });
      expect(sampleImage.getAttribute('style')).toContain('blur(0.25px)');

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(sampleImage.getAttribute('style')).toContain('blur(1px)');
      expect(image.style.filter).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables scaled export for sources the Rust export pipeline cannot decode', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.heic',
      images: [
        {
          path: 'C:/Images/photo.heic',
          file_name: 'photo.heic',
          extension: 'heic',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });
    const scaleSpy = vi.spyOn(tauriCommands, 'saveScaledCopy').mockResolvedValue(undefined);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Scaled export quality'));

    expect(screen.getByText(/Scaled export supports JPEG/)).toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();

    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(save).not.toHaveBeenCalled();
    expect(scaleSpy).not.toHaveBeenCalled();
  });

  it('defaults AVIF scaled exports to JPEG and restricts the save dialog filters', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.avif',
      images: [
        {
          path: 'C:/Images/photo.avif',
          file_name: 'photo.avif',
          extension: 'avif',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });
    vi.mocked(save).mockResolvedValue(null);

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Scaled export quality'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'C:/Images/photo-scaled-1200x800.jpg',
        filters: expect.arrayContaining([
          expect.objectContaining({ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }),
          expect.objectContaining({ name: 'PNG image', extensions: ['png'] }),
        ]),
      })
    );
  });

  it('rejects unsupported scaled export output extensions from the save dialog', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });
    vi.mocked(save).mockResolvedValue('C:/Images/photo-scaled.heic');
    const scaleSpy = vi.spyOn(tauriCommands, 'saveScaledCopy').mockResolvedValue(undefined);

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Scaled export quality'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Scale Copy',
        kind: 'error',
        message: expect.stringContaining('Scaled export can save JPEG'),
      })
    );
    expect(scaleSpy).not.toHaveBeenCalled();
  });

  it('blocks scaled copies above the export pixel cap before opening the save dialog', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        {
          path: 'C:/Images/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
    });
    const scaleSpy = vi.spyOn(tauriCommands, 'saveScaledCopy').mockResolvedValue(undefined);

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Scaled export quality'));
    fireEvent.change(screen.getByLabelText('Scaled copy width'), {
      target: { value: '65535' },
    });

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();

    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(save).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(scaleSpy).not.toHaveBeenCalled();
  });

  it('does not call overwrite command when overwrite confirmation is canceled', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      isCropMode: true,
      cropRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
    });
    vi.mocked(confirm).mockResolvedValue(false);
    const overwriteSpy = vi.spyOn(tauriCommands, 'overwriteWithCrop');

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Overwrite original with crop'));
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('photo.jpg'),
      expect.objectContaining({
        title: 'Overwrite Cropped Image',
        kind: 'warning',
      })
    );
    expect(vi.mocked(confirm).mock.calls[0]?.[0]).toContain('This modifies the source file.');
    expect(overwriteSpy).not.toHaveBeenCalled();
  });

  it('queues a cropped copy with the current crop rectangle', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      isCropMode: true,
      cropRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
      rotation: 90,
    });
    vi.mocked(save).mockResolvedValue('C:/Images/photo-cropped.jpg');
    const cropSpy = vi.spyOn(tauriCommands, 'saveCroppedCopy').mockResolvedValue(undefined);

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Queue cropped copy'));
    });

    expect(cropSpy).not.toHaveBeenCalled();
    expect(useEditQueueStore.getState().jobs).toMatchObject([
      {
        kind: 'cropped-copy',
        sourcePath: 'C:/Images/photo.jpg',
        outputPath: 'C:/Images/photo-cropped.jpg',
        cropRect: { x: 120, y: 160, width: 480, height: 240 },
        rotationDegrees: 90,
        status: 'queued',
      },
    ]);
  });

  it('saves pending crop edits as a new file when copy mode is configured', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        cropSaveMode: 'copy',
      },
    }));
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      pendingEditsByPath: {
        'C:/Images/photo.jpg': {
          rotationDegrees: 0,
          cropRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
          pendingCropPreview: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
          updatedAt: 1,
          history: [],
        },
      },
      cropRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
      pendingCropPreview: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
    });
    vi.mocked(save).mockResolvedValue('C:/Images/photo-cropped.jpg');
    const saveCopySpy = vi.spyOn(tauriCommands, 'saveCroppedCopy').mockResolvedValue(undefined);
    const overwriteSpy = vi.spyOn(tauriCommands, 'overwriteWithCrop').mockResolvedValue(undefined);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save pending edits'));
    });

    expect(saveCopySpy).toHaveBeenCalledWith(
      'C:/Images/photo.jpg',
      { x: 120, y: 160, width: 480, height: 240 },
      'C:/Images/photo-cropped.jpg',
      0
    );
    expect(overwriteSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(useViewerStore.getState().pendingEditsByPath['C:/Images/photo.jpg']).toBeUndefined();
    });
    expect(useViewerStore.getState().cropRect).toBeNull();
    expect(useViewerStore.getState().pendingCropPreview).toBeNull();
  });

  it('refreshes the metadata panel after a successful crop overwrite', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        cropSaveMode: 'overwrite',
      },
    }));
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      isCropMode: true,
      cropRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.spyOn(tauriCommands, 'overwriteWithCrop').mockResolvedValue(undefined);
    vi.spyOn(tauriCommands, 'getImageMetadata').mockResolvedValue({
      width: 1200,
      height: 800,
      file_size_bytes: 1000,
      format: 'JPEG',
    });
    vi.spyOn(tauriCommands, 'getExifMetadata').mockResolvedValue({ raw: {} });

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('More actions'));
      fireEvent.click(screen.getByLabelText('Toggle image info panel'));
    });

    await waitFor(() => {
      expect(tauriCommands.getImageMetadata).toHaveBeenCalledTimes(1);
      expect(tauriCommands.getExifMetadata).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Overwrite original with crop'));
    });

    await waitFor(() => {
      expect(tauriCommands.overwriteWithCrop).toHaveBeenCalledTimes(1);
      expect(tauriCommands.getImageMetadata).toHaveBeenCalledTimes(3);
      expect(tauriCommands.getExifMetadata).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps pending crop edits when save pending edits is canceled at confirmation', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        cropSaveMode: 'overwrite',
      },
    }));
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      pendingEditsByPath: {
        'C:/Images/photo.jpg': {
          rotationDegrees: 0,
          cropRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
          pendingCropPreview: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
          updatedAt: 1,
          history: [],
        },
      },
      cropRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
      pendingCropPreview: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
    });
    vi.mocked(confirm).mockResolvedValue(false);
    const overwriteSpy = vi.spyOn(tauriCommands, 'overwriteWithCrop');

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save pending edits'));
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('photo.jpg'),
      expect.objectContaining({
        title: 'Overwrite Cropped Image',
        kind: 'warning',
      })
    );
    expect(overwriteSpy).not.toHaveBeenCalled();
    expect(useViewerStore.getState().pendingEditsByPath['C:/Images/photo.jpg']).toBeDefined();
  });

  it('commits pending crop edits after confirmation', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        cropSaveMode: 'overwrite',
      },
    }));
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      pendingEditsByPath: {
        'C:/Images/photo.jpg': {
          rotationDegrees: 0,
          cropRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
          pendingCropPreview: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
          updatedAt: 1,
          history: [],
        },
      },
      cropRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
      pendingCropPreview: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.spyOn(tauriCommands, 'overwriteWithCrop').mockResolvedValue(undefined);

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save pending edits'));
    });

    await waitFor(() => {
      expect(tauriCommands.overwriteWithCrop).toHaveBeenCalledTimes(1);
      expect(useViewerStore.getState().pendingEditsByPath['C:/Images/photo.jpg']).toBeUndefined();
    });
  });

  it('prompts to switch to grid view when projector mode opens from viewer mode', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', viewMode: 'viewer' });
    vi.spyOn(tauriCommands, 'openSecondaryWindow').mockResolvedValue(undefined);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Open projector mode'));
    });

    expect(await screen.findByRole('dialog', { name: 'Projector mode setup' })).toBeInTheDocument();
    expect(screen.getByText(/works best with grid view/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to Grid' }));
    });

    expect(useViewerStore.getState().viewMode).toBe('grid');
    expect(useSettingsStore.getState().settings.openProjectorInGridView).toBe(true);
  });

  it('remembers switching to grid view for later projector launches when opting out of the prompt', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', viewMode: 'viewer' });
    vi.spyOn(tauriCommands, 'openSecondaryWindow').mockResolvedValue(undefined);

    const { unmount } = render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Open projector mode'));
    });

    fireEvent.click(screen.getByRole('checkbox', { name: /don't show this again/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to Grid' }));
    });

    expect(useSettingsStore.getState().settings.promptProjectorGridOnOpen).toBe(false);
    expect(useSettingsStore.getState().settings.openProjectorInGridView).toBe(true);

    unmount();
    useViewerStore.setState({ viewMode: 'viewer' });
    projectorState.isProjectorOpen = false;

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Open projector mode'));
    });

    expect(useViewerStore.getState().viewMode).toBe('grid');
    expect(screen.queryByRole('dialog', { name: 'Projector mode setup' })).not.toBeInTheDocument();
  });

  it('skips the projector grid prompt when the preference is disabled', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', viewMode: 'viewer' });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        promptProjectorGridOnOpen: false,
      },
    }));
    vi.spyOn(tauriCommands, 'openSecondaryWindow').mockResolvedValue(undefined);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Open projector mode'));
    });

    expect(screen.queryByRole('dialog', { name: 'Projector mode setup' })).not.toBeInTheDocument();
  });

  it('can remember keeping the current view without enabling automatic grid mode', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', viewMode: 'viewer' });
    vi.spyOn(tauriCommands, 'openSecondaryWindow').mockResolvedValue(undefined);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Open projector mode'));
    });

    fireEvent.click(screen.getByRole('checkbox', { name: /don't show this again/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep Current View' }));
    });

    expect(useSettingsStore.getState().settings.promptProjectorGridOnOpen).toBe(false);
    expect(useSettingsStore.getState().settings.openProjectorInGridView).toBe(false);
    expect(useViewerStore.getState().viewMode).toBe('viewer');
  });
});

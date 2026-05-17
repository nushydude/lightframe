import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ViewerChrome } from './ViewerChrome';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, message, save } from '@tauri-apps/plugin-dialog';
import * as tauriCommands from '../services/tauriCommands';

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
    onRefreshFolder: vi.fn(),
    onGoHome: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onStartSlideshow: vi.fn(),
    onTogglePause: vi.fn(),
  };

  beforeEach(() => {
    useViewerStore.getState().reset();
    useCurationStore.setState({ curationByPath: {}, isLoaded: false });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        promptProjectorGridOnOpen: true,
        openProjectorInGridView: false,
      },
    }));
    projectorState.isProjectorOpen = false;
    projectorState.refreshProjectorState.mockReset();
    vi.clearAllMocks();
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

  it('stores overflow action usage so the menu can learn over time', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByLabelText('Refresh folder'));

    await waitFor(() => {
      expect(window.localStorage.getItem('lightframe.toolbar-usage.v1')).toContain('"refresh":1');
    });
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

  it('toggles the favorites-only filter from the toolbar', () => {
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

    fireEvent.click(screen.getByLabelText('Show only favorites'));

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

    expect(message).toHaveBeenCalledWith(
      expect.stringContaining('Scaled export can save JPEG'),
      expect.objectContaining({ kind: 'error' })
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
    expect(message).not.toHaveBeenCalled();
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

  it('refreshes the metadata panel after a successful crop overwrite', async () => {
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
      expect(tauriCommands.getImageMetadata).toHaveBeenCalledTimes(2);
      expect(tauriCommands.getExifMetadata).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps pending crop edits when save pending edits is canceled at confirmation', async () => {
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

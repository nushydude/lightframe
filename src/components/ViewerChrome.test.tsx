import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ViewerChrome } from './ViewerChrome';
import { useViewerStore } from '../state/viewerStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import * as tauriCommands from '../services/tauriCommands';

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
    vi.clearAllMocks();
    document.body.innerHTML = '';
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

    const refreshButton = screen.getByLabelText('Refresh folder');
    expect(refreshButton).toBeEnabled();

    fireEvent.click(refreshButton);
    expect(defaultProps.onRefreshFolder).toHaveBeenCalledTimes(1);
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
});

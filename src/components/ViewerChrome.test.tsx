import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ViewerChrome } from './ViewerChrome';
import { useViewerStore } from '../state/viewerStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
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
        { path: 'C:/Images/photo.jpg', file_name: 'photo.jpg', extension: 'jpg', size_bytes: 100, modified_at: '1' },
        { path: 'C:/Images/other.jpg', file_name: 'other.jpg', extension: 'jpg', size_bytes: 200, modified_at: '2' },
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
        { path: 'C:/photo1.jpg', file_name: 'photo1.jpg', extension: 'jpg', size_bytes: 100, modified_at: '1' },
        { path: 'C:/photo2.jpg', file_name: 'photo2.jpg', extension: 'jpg', size_bytes: 200, modified_at: '2' },
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
});

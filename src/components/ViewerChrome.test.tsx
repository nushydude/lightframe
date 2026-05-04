import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ViewerChrome } from './ViewerChrome';
import { useViewerStore } from '../state/viewerStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';

describe('ViewerChrome', () => {
  const defaultProps = {
    onOpenFile: vi.fn(),
    onOpenFolder: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onStartSlideshow: vi.fn(),
    onTogglePause: vi.fn(),
  };

  beforeEach(() => {
    useViewerStore.getState().reset();
    vi.clearAllMocks();
  });

  it('should not render if no image is open', () => {
    const { container } = render(<ViewerChrome {...defaultProps} />);
    expect(container.firstChild).toBeNull();
  });

  it('should render file name and counter when image is open', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      images: [
        { path: 'C:/Images/photo.jpg', name: 'photo.jpg', size_bytes: 100, modified_at: '1' },
        { path: 'C:/Images/other.jpg', name: 'other.jpg', size_bytes: 200, modified_at: '2' },
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
        { path: 'C:/photo1.jpg', name: 'photo1.jpg', size_bytes: 100, modified_at: '1' },
        { path: 'C:/photo2.jpg', name: 'photo2.jpg', size_bytes: 200, modified_at: '2' },
      ],
    });

    render(<ViewerChrome {...defaultProps} />);

    const nextBtn = screen.getAllByLabelText('Next image')[0];
    fireEvent.click(nextBtn);

    expect(defaultProps.onNext).toHaveBeenCalledTimes(1);
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
});

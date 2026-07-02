import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompareView } from './CompareView';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { DEFAULT_SETTINGS } from '../types/settings';

const { getPreviewAssetMock } = vi.hoisted(() => ({
  getPreviewAssetMock: vi.fn(
    async (path: string) => `asset://localhost/cache/${encodeURIComponent(path)}.jpg`
  ),
}));

vi.mock('../services/imageAssetCache', () => ({
  getPreviewAsset: getPreviewAssetMock,
}));

describe('CompareView', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
    useSettingsStore.setState((state) => ({
      ...state,
      settings: DEFAULT_SETTINGS,
    }));
    vi.clearAllMocks();
  });

  it('renders two compare panes with focused state', async () => {
    useViewerStore.setState({
      images: [
        {
          path: 'c:/test/a.jpg',
          file_name: 'a.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
        {
          path: 'c:/test/b.jpg',
          file_name: 'b.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
      ],
      currentIndex: 0,
      currentImagePath: 'c:/test/a.jpg',
    });
    useViewerStore.getState().enterCompareMode();

    render(<CompareView />);

    await waitFor(() => {
      expect(getPreviewAssetMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText('a.jpg')).toBeInTheDocument();
    expect(screen.getByText('b.jpg')).toBeInTheDocument();

    const primaryPane = screen.getByLabelText('Primary image pane');
    const secondaryPane = screen.getByLabelText('Candidate image pane');
    expect(primaryPane).not.toHaveClass('focused');
    expect(secondaryPane).toHaveClass('focused');

    act(() => {
      useViewerStore.getState().switchCompareFocus();
    });

    expect(primaryPane).toHaveClass('focused');
    expect(secondaryPane).not.toHaveClass('focused');
  });

  it('applies wheel zoom to both compare panes together', async () => {
    useViewerStore.setState({
      images: [
        {
          path: 'c:/test/a.jpg',
          file_name: 'a.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
        {
          path: 'c:/test/b.jpg',
          file_name: 'b.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
      ],
      currentIndex: 0,
      currentImagePath: 'c:/test/a.jpg',
    });
    useViewerStore.getState().enterCompareMode();

    render(<CompareView />);

    await waitFor(() => {
      expect(getPreviewAssetMock).toHaveBeenCalledTimes(2);
    });

    const panes = Array.from(
      document.querySelectorAll<HTMLImageElement>('.compare-pane-canvas img')
    );
    const primaryCanvas = screen
      .getByLabelText('Primary image pane')
      .querySelector('.compare-pane-canvas') as HTMLDivElement;

    fireEvent.wheel(primaryCanvas, { deltaY: -100 });

    await waitFor(() => {
      expect(useViewerStore.getState().zoomMode).toBe('custom');
    });
    expect(useViewerStore.getState().zoomLevel).toBeGreaterThan(1);
    expect((panes[0] as HTMLImageElement).style.transform).toBe(
      (panes[1] as HTMLImageElement).style.transform
    );
  });

  it('pans both compare panes together while zoomed', async () => {
    useViewerStore.setState({
      images: [
        {
          path: 'c:/test/a.jpg',
          file_name: 'a.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
        {
          path: 'c:/test/b.jpg',
          file_name: 'b.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
      ],
      currentIndex: 0,
      currentImagePath: 'c:/test/a.jpg',
    });
    useViewerStore.getState().enterCompareMode();
    useViewerStore.getState().setZoomLevel(2);

    render(<CompareView />);

    await waitFor(() => {
      expect(getPreviewAssetMock).toHaveBeenCalledTimes(2);
    });

    const primaryPane = screen.getByLabelText('Primary image pane');
    const primaryCanvas = primaryPane.querySelector('.compare-pane-canvas') as HTMLDivElement;
    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>('.compare-pane-canvas img')
    );

    fireEvent.mouseDown(primaryCanvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(primaryCanvas, { clientX: 35, clientY: 50 });
    fireEvent.mouseUp(primaryCanvas);

    expect(useViewerStore.getState().panX).toBe(25);
    expect(useViewerStore.getState().panY).toBe(40);
    expect(images[0].style.transform).toBe(images[1].style.transform);
    expect(images[0].style.transform).toContain('translate(25px, 40px)');
  });

  it('uses wheel navigation to cycle the focused compare image when navigation mode is enabled', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        mouseWheelBehavior: 'navigate',
      },
    }));
    useViewerStore.setState({
      images: [
        {
          path: 'c:/test/a.jpg',
          file_name: 'a.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
        {
          path: 'c:/test/b.jpg',
          file_name: 'b.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
        {
          path: 'c:/test/c.jpg',
          file_name: 'c.jpg',
          extension: 'jpg',
          size_bytes: 0,
          modified_at: null,
        },
      ],
      currentIndex: 0,
      currentImagePath: 'c:/test/a.jpg',
    });
    useViewerStore.getState().enterCompareMode();

    render(<CompareView />);

    await waitFor(() => {
      expect(getPreviewAssetMock).toHaveBeenCalledTimes(2);
    });

    const candidateCanvas = screen
      .getByLabelText('Candidate image pane')
      .querySelector('.compare-pane-canvas') as HTMLDivElement;

    fireEvent.wheel(candidateCanvas, { deltaY: 100 });

    await waitFor(() => {
      expect(useViewerStore.getState().compareSecondaryIndex).toBe(2);
    });
    expect(useViewerStore.getState().zoomMode).toBe('fit');
    expect(screen.getByText('c.jpg')).toBeInTheDocument();
  });
});

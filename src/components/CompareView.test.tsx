import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompareView } from './CompareView';
import { useViewerStore } from '../state/viewerStore';

const { getPreviewAssetMock } = vi.hoisted(() => ({
  getPreviewAssetMock: vi.fn(async (path: string) => `asset://localhost/cache/${encodeURIComponent(path)}.jpg`),
}));

vi.mock('../services/imageAssetCache', () => ({
  getPreviewAsset: getPreviewAssetMock,
}));

describe('CompareView', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
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
});

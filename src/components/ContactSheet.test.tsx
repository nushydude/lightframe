import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactSheet } from './ContactSheet';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';

const {
  copyCurrentImageMock,
  deleteCurrentImageMock,
  openCurrentImageInEditorMock,
  revealCurrentImageMock,
  openSecondaryWindowMock,
  refreshProjectorStateMock,
} = vi.hoisted(() => ({
  copyCurrentImageMock: vi.fn(async () => undefined),
  deleteCurrentImageMock: vi.fn(async () => undefined),
  openCurrentImageInEditorMock: vi.fn(async () => undefined),
  revealCurrentImageMock: vi.fn(async () => undefined),
  openSecondaryWindowMock: vi.fn(async () => undefined),
  refreshProjectorStateMock: vi.fn(async () => undefined),
}));

const projectorState = vi.hoisted(() => ({
  isProjectorOpen: false,
}));

vi.mock('../services/thumbnailCache', () => ({
  evictThumbnailsExcept: vi.fn(),
  getCachedThumbnail: vi.fn(() => undefined),
  invalidateThumbnail: vi.fn(),
  preloadThumbnails: vi.fn(),
}));

vi.mock('../hooks/useThumbnailRefreshSignal', () => ({
  useThumbnailRefreshSignal: () => ({
    handleThumbnailLoaded: vi.fn(),
    isThumbnailConsumerActive: () => true,
  }),
}));

vi.mock('../hooks/useProjectorState', () => ({
  useProjectorState: () => ({
    isProjectorOpen: projectorState.isProjectorOpen,
    refreshProjectorState: refreshProjectorStateMock,
  }),
}));

vi.mock('../services/tauriCommands', () => ({
  closeSecondaryWindow: vi.fn(async () => undefined),
  openSecondaryWindow: openSecondaryWindowMock,
}));

vi.mock('../services/imageAssetCache', () => ({
  invalidateImageAsset: vi.fn(),
}));

vi.mock('../services/viewerActions', () => ({
  copyCurrentImage: copyCurrentImageMock,
  deleteCurrentImage: deleteCurrentImageMock,
  openCurrentImageInEditor: openCurrentImageInEditorMock,
  revealCurrentImage: revealCurrentImageMock,
  showTransferResultMessage: vi.fn(async () => undefined),
  transferImagesToDestination: vi.fn(async () => ({
    successes: [],
    failures: [],
  })),
}));

describe('ContactSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectorState.isProjectorOpen = false;
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        disconnect() {}
      }
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    useViewerStore.getState().reset();
    useViewerStore.setState({
      currentIndex: 0,
      viewMode: 'grid',
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });
    useCurationStore.setState({ curationByPath: {} });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        externalEditorLabel: 'Paint.NET',
        openProjectorInGridView: true,
      },
    }));
  });

  it('shows the overflow actions menu in grid view', () => {
    render(
      <ContactSheet
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    expect(screen.getByRole('button', { name: 'Back to landing page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle favorite' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle fullscreen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle grid view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle compare view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle crop mode' })).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
  });

  it('can open projector mode from grid view actions', () => {
    render(
      <ContactSheet
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open projector mode' }));

    return waitFor(() => {
      expect(openSecondaryWindowMock).toHaveBeenCalledTimes(1);
      expect(refreshProjectorStateMock).toHaveBeenCalledTimes(1);
    });
  });

  it('starts slideshow from grid view after the grid exit flow succeeds', async () => {
    const onStartSlideshow = vi.fn();
    const onExitGridView = vi.fn(async () => {
      useViewerStore.getState().setViewMode('viewer');
      return true;
    });
    useViewerStore.setState({
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    render(
      <ContactSheet
        onExitGridView={onExitGridView}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={onStartSlideshow}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start slideshow' }));

    await waitFor(() => {
      expect(onExitGridView).toHaveBeenCalledTimes(1);
      expect(onStartSlideshow).toHaveBeenCalledTimes(1);
      expect(useViewerStore.getState().viewMode).toBe('viewer');
    });
  });

  it('does not start slideshow when the grid exit flow is canceled', async () => {
    const onStartSlideshow = vi.fn();
    const onExitGridView = vi.fn(async () => false);
    useViewerStore.setState({
      images: [
        {
          path: 'C:/images/current.jpg',
          file_name: 'current.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
      ],
    });

    render(
      <ContactSheet
        onExitGridView={onExitGridView}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={onStartSlideshow}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start slideshow' }));

    await waitFor(() => {
      expect(onExitGridView).toHaveBeenCalledTimes(1);
    });
    expect(onStartSlideshow).not.toHaveBeenCalled();
  });
});

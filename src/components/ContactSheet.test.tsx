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
    render(<ContactSheet onGoHome={() => undefined} onRefreshFolder={() => undefined} />);

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit in Paint.NET' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open projector mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('can open projector mode from grid view actions', () => {
    render(<ContactSheet onGoHome={() => undefined} onRefreshFolder={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open projector mode' }));

    return waitFor(() => {
      expect(openSecondaryWindowMock).toHaveBeenCalledTimes(1);
      expect(refreshProjectorStateMock).toHaveBeenCalledTimes(1);
    });
  });
});

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThumbnailStrip } from './ThumbnailStrip';
import { ContactSheet } from './ContactSheet';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';

const {
  getCachedThumbnailMock,
  preloadThumbnailsMock,
  evictThumbnailsExceptMock,
  invalidateThumbnailMock,
} = vi.hoisted(() => ({
  getCachedThumbnailMock: vi.fn(() => undefined),
  preloadThumbnailsMock: vi.fn(),
  evictThumbnailsExceptMock: vi.fn(),
  invalidateThumbnailMock: vi.fn(),
}));

vi.mock('../services/thumbnailCache', () => ({
  evictThumbnailsExcept: evictThumbnailsExceptMock,
  getCachedThumbnail: getCachedThumbnailMock,
  invalidateThumbnail: invalidateThumbnailMock,
  preloadThumbnails: preloadThumbnailsMock,
}));

vi.mock('../hooks/useThumbnailRefreshSignal', () => ({
  useThumbnailRefreshSignal: () => ({
    handleThumbnailLoaded: vi.fn(),
    isThumbnailConsumerActive: () => true,
  }),
}));

vi.mock('../hooks/useProjectorState', () => ({
  useProjectorState: () => ({
    isProjectorOpen: false,
    refreshProjectorState: vi.fn(async () => undefined),
  }),
}));

vi.mock('../services/tauriCommands', () => ({
  closeSecondaryWindow: vi.fn(async () => undefined),
}));

vi.mock('../services/imageAssetCache', () => ({
  invalidateImageAsset: vi.fn(),
}));

vi.mock('../services/viewerActions', () => ({
  showTransferResultMessage: vi.fn(async () => undefined),
  transferImagesToDestination: vi.fn(async () => ({
    successes: [],
    failures: [],
  })),
}));

describe('thumbnail consumers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    useCurationStore.setState({ curationByPath: {} });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        quickDestinations: [],
      },
    }));
  });

  it('renders a strip placeholder when no thumbnail URL is cached yet', () => {
    useViewerStore.setState({
      currentIndex: 0,
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

    const { container } = render(<ThumbnailStrip />);

    expect(container.querySelector('.thumbnail-placeholder')).not.toBeNull();
  });

  it('renders a contact sheet placeholder when a thumbnail request has not completed', () => {
    useViewerStore.setState({
      currentIndex: 0,
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

    const { container } = render(
      <ContactSheet
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
      />
    );

    expect(container.querySelector('.grid-placeholder')).not.toBeNull();
  });
});

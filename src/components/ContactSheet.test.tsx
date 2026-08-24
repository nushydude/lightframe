import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactSheet } from './ContactSheet';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';

const {
  copyCurrentImageMock,
  copyCurrentImagePathMock,
  deleteImagesMock,
  deleteCurrentImageMock,
  openCurrentImageInEditorMock,
  revealCurrentImageMock,
  showTransferResultMessageMock,
  transferImagesToDestinationMock,
  chooseQuickDestinationFolderMock,
  openSecondaryWindowMock,
  refreshProjectorStateMock,
  writeImageCurationMock,
  writeImageCurationBatchMock,
} = vi.hoisted(() => ({
  copyCurrentImageMock: vi.fn(async () => undefined),
  copyCurrentImagePathMock: vi.fn(async () => undefined),
  deleteImagesMock: vi.fn(async () => undefined),
  deleteCurrentImageMock: vi.fn(async () => undefined),
  openCurrentImageInEditorMock: vi.fn(async () => undefined),
  revealCurrentImageMock: vi.fn(async () => undefined),
  showTransferResultMessageMock: vi.fn(async () => undefined),
  transferImagesToDestinationMock: vi.fn(async () => ({
    successes: [] as Array<{ sourcePath: string; targetPath: string }>,
    failures: [] as Array<{ sourcePath: string; error: string }>,
  })),
  chooseQuickDestinationFolderMock: vi.fn(async () => null),
  openSecondaryWindowMock: vi.fn(async () => undefined),
  refreshProjectorStateMock: vi.fn(async () => undefined),
  writeImageCurationMock: vi.fn(async () => undefined),
  writeImageCurationBatchMock: vi.fn((): Promise<void> => Promise.resolve()),
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
  clearImageCuration: vi.fn(async () => undefined),
  closeSecondaryWindow: vi.fn(async () => undefined),
  openSecondaryWindow: openSecondaryWindowMock,
  readCurationMetadata: vi.fn(async () => ({})),
  writeImageCuration: writeImageCurationMock,
  writeImageCurationBatch: writeImageCurationBatchMock,
}));

vi.mock('../services/imageAssetCache', () => ({
  invalidateImageAsset: vi.fn(),
}));

vi.mock('../services/viewerActions', () => ({
  chooseQuickDestinationFolder: chooseQuickDestinationFolderMock,
  copyCurrentImage: copyCurrentImageMock,
  copyCurrentImagePath: copyCurrentImagePathMock,
  deleteImages: deleteImagesMock,
  deleteCurrentImage: deleteCurrentImageMock,
  openCurrentImageInEditor: openCurrentImageInEditorMock,
  revealCurrentImage: revealCurrentImageMock,
  showTransferResultMessage: showTransferResultMessageMock,
  transferImagesToDestination: transferImagesToDestinationMock,
}));

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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
        quickDestinations: [{ id: 'fav', label: 'Favorites', path: 'D:/Favorites' }],
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

    const startButton = screen.getByRole('button', { name: 'Return to start screen' });
    expect(startButton).toBeInTheDocument();
    expect(startButton).toHaveTextContent('Start');
    expect(startButton).toHaveAttribute('title', 'Return to start screen');
    expect(startButton).toHaveAttribute('data-tooltip', 'Return to start screen');
    expect(screen.getByRole('button', { name: 'Open file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle favorite' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle fullscreen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle grid view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle compare view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle crop mode' })).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
  });

  it('searches filenames and opens a result using its source index', () => {
    useViewerStore.setState({
      currentIndex: 0,
      images: [
        {
          path: 'first',
          file_name: 'first.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'hidden',
          file_name: 'hidden.jpg',
          extension: 'jpg',
          size_bytes: 2,
          modified_at: '2',
        },
        {
          path: 'target',
          file_name: 'target.png',
          extension: 'png',
          size_bytes: 3,
          modified_at: '3',
        },
      ],
    });
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

    const input = screen.getByRole('searchbox', {
      name: 'Search filenames',
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'target' } });
    expect(screen.getByText('1 of 3 images')).toBeInTheDocument();
    fireEvent.click(screen.getByText('target.png'));
    expect(useViewerStore.getState().currentIndex).toBe(2);
  });

  it('uses displayed result order for shift selection and removes hidden selections', () => {
    useViewerStore.setState({
      currentIndex: 0,
      images: [
        {
          path: 'match-a',
          file_name: 'match-a.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'hidden',
          file_name: 'hidden.jpg',
          extension: 'jpg',
          size_bytes: 2,
          modified_at: '2',
        },
        {
          path: 'match-b',
          file_name: 'match-b.jpg',
          extension: 'jpg',
          size_bytes: 3,
          modified_at: '3',
        },
      ],
    });
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

    const input = screen.getByRole('searchbox', { name: 'Search filenames' });
    fireEvent.change(input, { target: { value: 'match' } });
    fireEvent.click(screen.getByText('match-a.jpg'), { ctrlKey: true });
    fireEvent.click(screen.getByText('match-b.jpg'), { shiftKey: true });
    expect(screen.getAllByText('2 selected')[0]).toBeInTheDocument();
    expect(screen.queryByText('hidden.jpg')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'match-b' } });
    expect(screen.getAllByText('1 selected')[0]).toBeInTheDocument();
  });

  it('focuses search on Ctrl+F and clears before exiting on Escape', () => {
    const onExitGridView = vi.fn(async () => true);
    render(
      <ContactSheet
        onExitGridView={onExitGridView}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );
    const input = screen.getByRole('searchbox', { name: 'Search filenames' });
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'current' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
    expect(onExitGridView).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onExitGridView).toHaveBeenCalledTimes(1);
  });

  it('keeps search focused while typing multiple characters', () => {
    useViewerStore.setState({
      currentIndex: 0,
      images: Array.from({ length: 8 }, (_, index) => ({
        path: `C:/images/${index}.jpg`,
        file_name: `photo-${index}.jpg`,
        extension: 'jpg',
        size_bytes: 1,
        modified_at: String(index),
      })),
    });

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

    const input = screen.getByRole('searchbox', { name: 'Search filenames' }) as HTMLInputElement;
    input.focus();
    for (const character of 'photo-7') {
      fireEvent.change(input, { target: { value: input.value + character } });
      expect(document.activeElement).toBe(input);
    }
    expect(input).toHaveValue('photo-7');
  });

  it('focuses an off-screen target after End and Home virtualize it', () => {
    const images = Array.from({ length: 40 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: String(index),
    }));
    useViewerStore.setState({ currentIndex: 0, images });

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

    fireEvent.keyDown(window, { key: 'End' });
    const lastCell = screen.getByRole('gridcell', { name: '39.jpg' });
    expect(document.activeElement).toBe(lastCell);

    fireEvent.keyDown(lastCell, { key: 'Home' });
    const firstCell = screen.getByRole('gridcell', { name: '0.jpg' });
    expect(document.activeElement).toBe(firstCell);
  });

  it('pages the grid scroll container with Page Up and Page Down', () => {
    const images = Array.from({ length: 40 }, (_, index) => ({
      path: `C:/images/${index}.jpg`,
      file_name: `${index}.jpg`,
      extension: 'jpg',
      size_bytes: 1,
      modified_at: String(index),
    }));
    useViewerStore.setState({ currentIndex: 0, images });

    const { container } = render(
      <ContactSheet
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );
    const content = container.querySelector('.contact-sheet-content') as HTMLDivElement;
    Object.defineProperty(content, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 2000 });
    content.scrollTop = 600;

    fireEvent.keyDown(window, { key: 'PageDown' });
    expect(content.scrollTo).toHaveBeenCalledWith({
      top: 1000,
      behavior: 'auto',
    });

    content.scrollTop = 1000;
    fireEvent.keyDown(window, { key: 'PageUp' });
    expect(content.scrollTo).toHaveBeenLastCalledWith({
      top: 600,
      behavior: 'auto',
    });
  });

  it('shows the no-match message while keeping search available', () => {
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
    const input = screen.getByRole('searchbox', { name: 'Search filenames' });
    fireEvent.change(input, { target: { value: 'missing' } });
    expect(screen.getByText('No filenames match “missing”.')).toBeInTheDocument();
    expect(input).toBeInTheDocument();
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

  it('shows batch curation actions for selected grid images', async () => {
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
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    fireEvent.click(screen.getByText('current.jpg'), { ctrlKey: true });
    fireEvent.click(screen.getByText('next.jpg'), { ctrlKey: true });

    const bulkToolbar = screen.getByRole('toolbar', { name: 'Selected image actions' });
    expect(within(bulkToolbar).getByText('2 selected')).toBeInTheDocument();

    fireEvent.click(within(bulkToolbar).getByRole('button', { name: 'Favorite' }));
    await waitFor(() => {
      expect(writeImageCurationBatchMock).toHaveBeenCalledWith([
        { filePath: 'C:/images/current.jpg', favorite: true, rating: 0 },
        { filePath: 'C:/images/next.jpg', favorite: true, rating: 0 },
      ]);
    });

    fireEvent.click(within(bulkToolbar).getByRole('button', { name: 'Rate selected 5' }));
    await waitFor(() => {
      expect(writeImageCurationBatchMock).toHaveBeenCalledWith([
        { filePath: 'C:/images/current.jpg', favorite: true, rating: 5 },
        { filePath: 'C:/images/next.jpg', favorite: true, rating: 5 },
      ]);
    });
  });

  it('disables batch curation actions while a selected-image mutation is pending', async () => {
    const batch = createDeferredVoid();
    writeImageCurationBatchMock.mockReturnValue(batch.promise);
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
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    fireEvent.click(screen.getByText('current.jpg'), { ctrlKey: true });
    const bulkToolbar = screen.getByRole('toolbar', { name: 'Selected image actions' });
    fireEvent.click(within(bulkToolbar).getByRole('button', { name: 'Favorite' }));

    const rateFiveButton = within(bulkToolbar).getByRole('button', { name: 'Rate selected 5' });
    await waitFor(() => {
      expect(rateFiveButton).toBeDisabled();
    });

    fireEvent.click(rateFiveButton);
    expect(writeImageCurationBatchMock).toHaveBeenCalledTimes(1);

    batch.resolve();
    await waitFor(() => {
      expect(rateFiveButton).not.toBeDisabled();
    });
  });

  it('copies selected grid images to a quick destination', async () => {
    transferImagesToDestinationMock.mockResolvedValue({
      successes: [
        { sourcePath: 'C:/images/current.jpg', targetPath: 'D:/Favorites/current.jpg' },
        { sourcePath: 'C:/images/next.jpg', targetPath: 'D:/Favorites/next.jpg' },
      ],
      failures: [],
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
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    fireEvent.click(screen.getByText('current.jpg'), { ctrlKey: true });
    fireEvent.click(screen.getByText('next.jpg'), { ctrlKey: true });
    const bulkToolbar = screen.getByRole('toolbar', { name: 'Selected image actions' });
    fireEvent.click(within(bulkToolbar).getByText('Copy To'));
    fireEvent.click(within(bulkToolbar).getAllByRole('button', { name: 'Favorites' })[0]);

    await waitFor(() => {
      expect(transferImagesToDestinationMock).toHaveBeenCalledWith(
        ['C:/images/current.jpg', 'C:/images/next.jpg'],
        { id: 'fav', label: 'Favorites', path: 'D:/Favorites' },
        'copy'
      );
      expect(showTransferResultMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ failures: [] }),
        { id: 'fav', label: 'Favorites', path: 'D:/Favorites' },
        'copy'
      );
    });
  });

  it('removes moved selected grid images from the folder view', async () => {
    transferImagesToDestinationMock.mockResolvedValue({
      successes: [{ sourcePath: 'C:/images/current.jpg', targetPath: 'D:/Favorites/current.jpg' }],
      failures: [],
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
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    fireEvent.click(screen.getByText('current.jpg'), { ctrlKey: true });
    const bulkToolbar = screen.getByRole('toolbar', { name: 'Selected image actions' });
    fireEvent.click(within(bulkToolbar).getByText('Move To'));
    fireEvent.click(within(bulkToolbar).getAllByRole('button', { name: 'Favorites' })[1]);

    await waitFor(() => {
      expect(transferImagesToDestinationMock).toHaveBeenCalledWith(
        ['C:/images/current.jpg'],
        { id: 'fav', label: 'Favorites', path: 'D:/Favorites' },
        'move'
      );
      expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
        'C:/images/next.jpg',
      ]);
    });
  });

  it('deletes selected grid images from the bulk bar', async () => {
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
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    fireEvent.click(screen.getByText('current.jpg'), { ctrlKey: true });
    fireEvent.click(screen.getByText('next.jpg'), { ctrlKey: true });
    const bulkToolbar = screen.getByRole('toolbar', { name: 'Selected image actions' });
    fireEvent.click(within(bulkToolbar).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteImagesMock).toHaveBeenCalledWith({
        imagePaths: ['C:/images/current.jpg', 'C:/images/next.jpg'],
        removeImagesByPaths: expect.any(Function),
      });
    });
  });

  it('closes the bulk quick-destination menu when clicking outside the overlay menus', async () => {
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
        onExitGridView={vi.fn(async () => true)}
        onGoHome={() => undefined}
        onOpenFile={() => undefined}
        onOpenFolder={() => undefined}
        onRefreshFolder={() => undefined}
        onStartSlideshow={() => undefined}
      />
    );

    fireEvent.click(screen.getByText('current.jpg'), { ctrlKey: true });
    fireEvent.click(screen.getByText('next.jpg'), { ctrlKey: true });
    const copySelectedSummary = screen.getByLabelText('Copy selected images');
    const copySelectedMenu = copySelectedSummary.closest('details');
    expect(copySelectedMenu).not.toBeNull();

    fireEvent.click(copySelectedSummary);

    expect(copySelectedMenu).toHaveAttribute('open');

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(copySelectedMenu).not.toHaveAttribute('open');
    });
  });
});

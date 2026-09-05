import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { ViewerChrome } from './ViewerChrome';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useEditQueueStore } from '../state/editQueueStore';
import { useSettingsStore } from '../state/settingsStore';
import { DEFAULT_SETTINGS } from '../types/settings';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import * as tauriCommands from '../services/tauriCommands';
import * as viewerActions from '../services/viewerActions';
import { useToastStore } from '../state/toastStore';

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
    onOpenRecentFolder: vi.fn(),
    onRefreshFolder: vi.fn(),
    onGoHome: vi.fn(),
    onFirst: vi.fn(),
    onLast: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onStartSlideshow: vi.fn(),
    onStopSlideshow: vi.fn(),
    onTogglePause: vi.fn(),
  };

  beforeEach(() => {
    useViewerStore.getState().reset();
    useCurationStore.setState({ curationByPath: {}, isLoaded: false });
    useEditQueueStore.getState().reset();
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...DEFAULT_SETTINGS,
        promptProjectorGridOnOpen: true,
        openProjectorInGridView: false,
      },
    }));
    projectorState.isProjectorOpen = false;
    projectorState.refreshProjectorState.mockReset();
    vi.clearAllMocks();
    vi.spyOn(tauriCommands, 'getImageMetadata').mockResolvedValue({
      width: 1200,
      height: 800,
      file_size_bytes: 1000,
      format: 'JPEG',
    });
    vi.spyOn(tauriCommands, 'getImageCaption').mockResolvedValue(null);
    useToastStore.getState().clearToasts();
    document.body.innerHTML = '';
    window.localStorage.clear();
  });

  it('should not render if no image is open', () => {
    const { container } = render(<ViewerChrome {...defaultProps} />);
    expect(container.firstChild).toBeNull();
  });

  it('does not commit chrome renders for pan-only store updates', () => {
    let commitCount = 0;
    render(
      <Profiler id="viewer-chrome" onRender={() => commitCount++}>
        <ViewerChrome {...defaultProps} />
      </Profiler>
    );

    commitCount = 0;
    act(() => {
      useViewerStore.getState().setPan(24, 36);
    });

    expect(commitCount).toBe(0);
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

  it('shows a same-basename caption while browsing and copies it', async () => {
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
    vi.mocked(tauriCommands.getImageCaption).mockResolvedValue({
      text: 'subject token, portrait, soft light',
      sidecar_path: 'C:/Images/photo.txt',
      extension: 'txt',
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(await screen.findByText('subject token, portrait, soft light')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy image caption' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('subject token, portrait, soft light')
    );
  });

  it('keeps caption expansion shared across image navigation', async () => {
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
          path: 'C:/Images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });
    vi.mocked(tauriCommands.getImageCaption).mockImplementation(async (filePath) => ({
      text:
        filePath === 'C:/Images/photo.jpg'
          ? 'first caption, long prompt details'
          : 'second caption, different prompt details',
      sidecar_path:
        filePath === 'C:/Images/photo.jpg' ? 'C:/Images/photo.txt' : 'C:/Images/next.txt',
      extension: 'txt',
    }));

    render(<ViewerChrome {...defaultProps} />);

    expect(await screen.findByText('first caption, long prompt details')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand image caption' }));
    expect(screen.getByRole('button', { name: 'Collapse image caption' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    act(() => {
      useViewerStore.setState({
        currentImagePath: 'C:/Images/next.jpg',
        currentIndex: 1,
      });
    });

    expect(await screen.findByText('second caption, different prompt details')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse image caption' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('toggles global caption expansion from the View actions menu', async () => {
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
    vi.mocked(tauriCommands.getImageCaption).mockResolvedValue({
      text: 'subject token, portrait, soft light',
      sidecar_path: 'C:/Images/photo.txt',
      extension: 'txt',
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(await screen.findByText('subject token, portrait, soft light')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand image caption' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    const moreButton = screen.getByLabelText('More actions');
    const moreMenu = moreButton.closest('details') as HTMLDetailsElement;
    fireEvent.click(moreButton);

    const expandCaptionsButton = screen.getByRole('button', { name: 'Expand image captions' });
    expect(expandCaptionsButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(expandCaptionsButton);

    expect(moreMenu.open).toBe(false);
    expect(screen.getByRole('button', { name: 'Collapse image caption' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    fireEvent.click(moreButton);
    expect(screen.getByRole('button', { name: 'Expand image captions' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('moves the caption into Image Info instead of overlapping the browsing overlay', async () => {
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
    vi.mocked(tauriCommands.getImageCaption).mockResolvedValue({
      text: 'subject token, portrait, soft light',
      sidecar_path: 'C:/Images/photo.txt',
      extension: 'txt',
    });
    vi.spyOn(tauriCommands, 'getExifMetadata').mockResolvedValue({ raw: {} });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    expect(await screen.findByText('subject token, portrait, soft light')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Toggle image info panel'));

    await waitFor(() => expect(container.querySelector('.exif-caption-text')).toBeInTheDocument());
    expect(container.querySelector('.image-caption-overlay')).not.toBeInTheDocument();
    expect(screen.getByText('photo.txt')).toBeInTheDocument();
  });

  it('hides the browsing overlay when captions are disabled but keeps Image Info available', async () => {
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
    useSettingsStore.setState((state) => ({
      ...state,
      settings: { ...state.settings, showImageCaptions: false },
    }));
    vi.mocked(tauriCommands.getImageCaption).mockResolvedValue({
      text: 'subject token, portrait, soft light',
      sidecar_path: 'C:/Images/photo.txt',
      extension: 'txt',
    });
    vi.spyOn(tauriCommands, 'getExifMetadata').mockResolvedValue({ raw: {} });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    await waitFor(() => expect(tauriCommands.getImageCaption).toHaveBeenCalled());
    expect(container.querySelector('.image-caption-overlay')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Toggle image info panel'));

    expect(await screen.findByText('subject token, portrait, soft light')).toBeInTheDocument();
    expect(screen.getByText('photo.txt')).toBeInTheDocument();
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

  it('should call onFirst when first-image button is clicked', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo2.jpg',
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
      currentIndex: 1,
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('First image'));

    expect(defaultProps.onFirst).toHaveBeenCalledTimes(1);
  });

  it('should call onLast when last-image button is clicked', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo1.jpg' });

    render(<ViewerChrome {...defaultProps} />);

    const lastButton = screen.getByRole('button', { name: 'Last image' });
    fireEvent.click(lastButton);

    expect(lastButton).toHaveAttribute('id', 'btn-ctrl-last');
    expect(lastButton).toHaveAttribute('title', 'Last image (End)');
    expect(lastButton).toHaveAttribute('data-tooltip', 'Last image (End)');
    expect(defaultProps.onLast).toHaveBeenCalledTimes(1);
  });

  it('renders endpoint and adjacent navigation controls in order', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo1.jpg',
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

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const toolbarIds = Array.from(container.querySelectorAll('.bottom-controls button')).map(
      (button) => button.id
    );

    expect(toolbarIds.slice(0, 4)).toEqual([
      'btn-ctrl-first',
      'btn-ctrl-prev',
      'btn-ctrl-next',
      'btn-ctrl-last',
    ]);
    expect(toolbarIds.indexOf('btn-ctrl-next')).toBeLessThan(
      toolbarIds.indexOf('btn-slideshow-shuffle')
    );
    expect(toolbarIds.indexOf('btn-slideshow-shuffle')).toBeLessThan(
      toolbarIds.indexOf('btn-start-slideshow')
    );
  });

  it('resets zoom to fit when clicking the zoom display text', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo.jpg',
      zoomMode: 'custom',
      zoomLevel: 1.75,
      panX: 24,
      panY: -12,
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Reset zoom to fit'));

    expect(useViewerStore.getState()).toMatchObject({
      zoomMode: 'fit',
      zoomLevel: 1,
      panX: 0,
      panY: 0,
    });
  });

  it('should call onGoHome when the home button is clicked', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg' });

    render(<ViewerChrome {...defaultProps} />);

    const startButton = screen.getByLabelText('Return to start screen');
    fireEvent.click(startButton);

    expect(startButton).toHaveTextContent('Start');
    expect(startButton).toHaveAttribute('title', 'Return to start screen');
    expect(startButton).toHaveAttribute('data-tooltip', 'Return to start screen');
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

  it('quickly toggles caption visibility from the View actions menu', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg' });

    render(<ViewerChrome {...defaultProps} />);

    const moreButton = screen.getByLabelText('More actions');
    const moreMenu = moreButton.closest('details') as HTMLDetailsElement;
    fireEvent.click(moreButton);

    const captionsButton = screen.getByRole('button', { name: 'Show image captions' });
    expect(captionsButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(captionsButton);

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.showImageCaptions).toBe(false);
    });
    expect(moreMenu.open).toBe(false);

    fireEvent.click(moreButton);
    const captionsButtonAfterToggle = screen.getByRole('button', {
      name: 'Show image captions',
    });
    expect(captionsButtonAfterToggle).toHaveTextContent('Show Captions');
    expect(captionsButtonAfterToggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps settings in the menu footer and exposes toolbar customization mode', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });

    const { container } = render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));

    const settingsButton = screen.getByRole('button', { name: 'Open settings' });
    expect(settingsButton.closest('.more-actions-footer')).toBeTruthy();

    const customizeButton = screen.getByRole('button', { name: 'Customize toolbar…' });
    expect(customizeButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(customizeButton);

    expect(screen.getByRole('button', { name: 'Done customizing' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(container.querySelector('.more-actions-panel')).toHaveClass('is-customizing');
  });

  it('reveals folder sort choices from a compact summary row', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    const sortSummary = screen.getByLabelText('Change folder sort');
    expect(sortSummary).toHaveTextContent('Sort: Filename');
    expect(screen.getByLabelText('Folder sort options').closest('details')).not.toHaveAttribute(
      'open'
    );

    fireEvent.click(sortSummary);
    expect(screen.getByLabelText('Folder sort options').closest('details')).toHaveAttribute('open');
  });

  it('opens recent folders from the overflow menu', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        recentFolders: [{ path: 'D:/Shoots/May', label: 'May', openedAt: 100 }],
      },
    }));

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByLabelText('Open recent folder'));
    fireEvent.click(screen.getByText('May'));

    expect(defaultProps.onOpenRecentFolder).toHaveBeenCalledWith('D:/Shoots/May', undefined);
  });

  it('opens recent folders into a saved preset from the overflow menu', () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        recentFolders: [{ path: 'D:/Shoots/May', label: 'May', openedAt: 100 }],
        savedViewPresets: ['rated4'],
      },
    }));

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByLabelText('Open recent folder'));
    const presetButtons = screen.getAllByRole('button', { name: '4+ Stars' });
    fireEvent.click(presetButtons[presetButtons.length - 1] as HTMLButtonElement);

    expect(defaultProps.onOpenRecentFolder).toHaveBeenCalledWith('D:/Shoots/May', 'rated4');
  });

  it('pins overflow actions into the top bar', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });

    const { container } = render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByLabelText('Pin Refresh'));

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.pinnedToolbarActions).toContain('refresh');
    });

    expect(container.querySelector('#btn-pinned-refresh')).toBeTruthy();
  });

  it('closes pinned top-bar submenus on outside click', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        recentFolders: [{ path: 'D:/Shoots/May', label: 'May', openedAt: 100 }],
      },
    }));

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByLabelText('Pin Recent Folders'));

    const pinnedRecentFoldersButton = screen.getAllByLabelText('Open recent folder').slice(-1)[0];
    const pinnedRecentFoldersMenu = pinnedRecentFoldersButton?.closest(
      'details'
    ) as HTMLDetailsElement;

    fireEvent.click(pinnedRecentFoldersButton as HTMLElement);
    expect(pinnedRecentFoldersMenu.open).toBe(true);

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(pinnedRecentFoldersMenu.open).toBe(false);
    });
  });

  it('closes overflow menus when clicking outside them', async () => {
    useViewerStore.setState({ currentImagePath: 'C:/photo.jpg', folderPath: 'C:/Images' });

    render(<ViewerChrome {...defaultProps} />);

    const moreButton = screen.getByLabelText('More actions');
    const moreMenu = moreButton.closest('details') as HTMLDetailsElement;

    fireEvent.click(moreButton);
    expect(moreMenu.open).toBe(true);

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(moreMenu.open).toBe(false);
    });
  });

  it('closes the slideshow options menu when clicking another control', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo.jpg',
      folderPath: 'C:/Images',
      images: [
        {
          path: 'C:/photo.jpg',
          file_name: 'photo.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 200,
          modified_at: '2',
        },
      ],
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const optionsTrigger = container.querySelector('.slideshow-options-trigger') as HTMLElement;
    const optionsMenu = optionsTrigger.closest('details') as HTMLDetailsElement;

    fireEvent.click(optionsTrigger);
    expect(optionsMenu.open).toBe(true);

    fireEvent.pointerDown(container.querySelector('#btn-ctrl-next') as HTMLElement);

    await waitFor(() => {
      expect(optionsMenu.open).toBe(false);
    });
  });

  it('closes bottom control menus on outside click and Escape', async () => {
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

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const canvas = document.createElement('div');
    canvas.className = 'image-canvas';
    canvas.appendChild(image);
    document.body.appendChild(canvas);

    render(<ViewerChrome {...defaultProps} />);

    const qualityButton = screen.getByLabelText('Scaled export quality');
    const qualityMenu = qualityButton.closest('details') as HTMLDetailsElement;

    fireEvent.click(qualityButton);
    expect(qualityMenu.open).toBe(true);

    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(qualityMenu.open).toBe(false);
    });

    fireEvent.click(qualityButton);
    expect(qualityMenu.open).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(qualityMenu.open).toBe(false);
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

    expect(screen.getByRole('status')).toHaveTextContent('Slideshow · Forward · 4s');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

    act(() => {
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, slideshowDirection: 'reverse' },
      }));
    });

    expect(screen.getByRole('status')).toHaveTextContent('Slideshow · Reverse · 4s');
  });

  it('shows and updates all slideshow options from the toolbar disclosure', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo1.jpg',
      images: [
        {
          path: 'C:/photo1.jpg',
          file_name: 'photo1.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '1',
        },
        {
          path: 'C:/photo2.jpg',
          file_name: 'photo2.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: '2',
        },
      ],
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const optionsTrigger = container.querySelector('.slideshow-options-trigger') as HTMLElement;
    fireEvent.click(optionsTrigger);

    expect(screen.getByLabelText('Slideshow order')).toHaveValue('sequential');
    expect(screen.getByLabelText('Slideshow direction')).toHaveValue('forward');
    expect(screen.getByLabelText('Slideshow repeat')).toHaveValue('off');
    expect(screen.getByLabelText('Slideshow interval in seconds')).toHaveValue(4);
    expect(screen.getByLabelText('Enter fullscreen automatically')).toBeChecked();

    fireEvent.keyDown(screen.getByRole('group', { name: 'Slideshow options' }), { key: 'Escape' });
    expect(document.activeElement).toBe(optionsTrigger);
    expect(optionsTrigger.parentElement).not.toHaveAttribute('open');
    fireEvent.click(optionsTrigger);

    fireEvent.change(screen.getByLabelText('Slideshow order'), { target: { value: 'shuffle' } });
    fireEvent.change(screen.getByLabelText('Slideshow direction'), {
      target: { value: 'reverse' },
    });
    fireEvent.change(screen.getByLabelText('Slideshow repeat'), { target: { value: 'on' } });
    fireEvent.change(screen.getByLabelText('Slideshow interval in seconds'), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByLabelText('Enter fullscreen automatically'));

    await waitFor(() => {
      expect(useSettingsStore.getState().settings).toMatchObject({
        shuffleSlideshow: true,
        slideshowDirection: 'reverse',
        loopSlideshow: true,
        slideshowIntervalSeconds: 12,
        autoFullscreenOnSlideshow: false,
      });
    });
  });

  it('shows stop slideshow controls when slideshow is active', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo1.jpg',
      isSlideshowActive: true,
      isSlideshowPaused: false,
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

    fireEvent.click(container.querySelector('#btn-stop-slideshow') as HTMLButtonElement);

    expect(defaultProps.onStopSlideshow).toHaveBeenCalledTimes(1);
    expect(screen.getAllByLabelText('Stop slideshow')).toHaveLength(2);
  });

  it('announces the current slideshow pause or resume action', () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo1.jpg',
      isSlideshowActive: true,
      isSlideshowPaused: false,
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

    const { rerender } = render(<ViewerChrome {...defaultProps} />);

    expect(screen.getAllByLabelText('Pause slideshow')).toHaveLength(2);

    useViewerStore.setState({ isSlideshowPaused: true });
    rerender(<ViewerChrome {...defaultProps} />);

    expect(screen.getAllByLabelText('Resume slideshow')).toHaveLength(2);
  });

  it('toggles slideshow shuffle from the playback controls', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/photo1.jpg',
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

    expect(screen.getByLabelText('Shuffle slideshow')).toBeInTheDocument();

    fireEvent.click(container.querySelector('#btn-slideshow-shuffle') as HTMLButtonElement);

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.shuffleSlideshow).toBe(true);
    });
    expect(screen.getByLabelText('Turn slideshow shuffle off')).toBeInTheDocument();
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

  it('applies a curation filter from the toolbar menu', () => {
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

    fireEvent.click(screen.getByLabelText('Filter images'));
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));

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

  it('toggles the marked state from the top bar', () => {
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

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Mark current image'));
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/photo.jpg']);

    fireEvent.click(screen.getByLabelText('Unmark current image'));
    expect(useViewerStore.getState().markedPaths).toEqual([]);
  });

  it('preserves marked paths when bulk delete is canceled', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/one.jpg',
      images: [
        {
          path: 'C:/Images/one.jpg',
          file_name: 'one.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/two.jpg',
          file_name: 'two.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/one.jpg', 'C:/Images/two.jpg'],
    });
    vi.mocked(confirm).mockResolvedValue(false);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const bulkToolbar = await screen.findByRole('toolbar', { name: 'Marked image actions' });
    await act(async () => {
      fireEvent.click(within(bulkToolbar).getByRole('button', { name: 'Delete Marked' }));
    });

    expect(useViewerStore.getState().markedPaths).toEqual([
      'C:/Images/one.jpg',
      'C:/Images/two.jpg',
    ]);
  });

  it('keeps failed marked items selected after a partial bulk delete failure', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/one.jpg',
      images: [
        {
          path: 'C:/Images/one.jpg',
          file_name: 'one.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/two.jpg',
          file_name: 'two.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/one.jpg', 'C:/Images/two.jpg'],
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.spyOn(tauriCommands, 'moveToTrash')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('locked'));

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const bulkToolbar = await screen.findByRole('toolbar', { name: 'Marked image actions' });
    await act(async () => {
      fireEvent.click(within(bulkToolbar).getByRole('button', { name: 'Delete Marked' }));
    });

    await waitFor(() => {
      expect(useViewerStore.getState().images.map((image) => image.path)).toEqual([
        'C:/Images/two.jpg',
      ]);
    });
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/two.jpg']);
  });

  it('clears successfully copied marked images after a bulk copy', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/one.jpg',
      images: [
        {
          path: 'C:/Images/one.jpg',
          file_name: 'one.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/two.jpg',
          file_name: 'two.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/one.jpg', 'C:/Images/two.jpg'],
    });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        quickDestinations: [{ id: 'export', label: 'Export', path: 'D:/Export' }],
      },
    }));
    vi.spyOn(viewerActions, 'transferImagesToDestination').mockResolvedValue({
      successes: [
        { sourcePath: 'C:/Images/one.jpg', targetPath: 'D:/Export/one.jpg' },
        { sourcePath: 'C:/Images/two.jpg', targetPath: 'D:/Export/two.jpg' },
      ],
      failures: [],
      failureCount: 0,
    });
    vi.spyOn(viewerActions, 'showTransferResultMessage').mockImplementation(() => undefined);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const bulkToolbar = await screen.findByRole('toolbar', { name: 'Marked image actions' });
    fireEvent.click(within(bulkToolbar).getByLabelText('Copy marked images to a destination'));
    const destinationButton = within(bulkToolbar).getAllByRole('button', { name: 'Export' })[0];

    await act(async () => {
      fireEvent.click(destinationButton);
    });

    await waitFor(() => {
      expect(useViewerStore.getState().markedPaths).toEqual([]);
    });
  });

  it('keeps only failed marked images selected after a partial bulk copy', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/one.jpg',
      images: [
        {
          path: 'C:/Images/one.jpg',
          file_name: 'one.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/two.jpg',
          file_name: 'two.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/one.jpg', 'C:/Images/two.jpg'],
    });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        quickDestinations: [{ id: 'export', label: 'Export', path: 'D:/Export' }],
      },
    }));
    vi.spyOn(viewerActions, 'transferImagesToDestination').mockResolvedValue({
      successes: [{ sourcePath: 'C:/Images/one.jpg', targetPath: 'D:/Export/one.jpg' }],
      failures: [{ sourcePath: 'C:/Images/two.jpg', error: 'disk full' }],
      failureCount: 1,
    });
    vi.spyOn(viewerActions, 'showTransferResultMessage').mockImplementation(() => undefined);

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const bulkToolbar = await screen.findByRole('toolbar', { name: 'Marked image actions' });
    fireEvent.click(within(bulkToolbar).getByLabelText('Copy marked images to a destination'));
    const destinationButton = within(bulkToolbar).getAllByRole('button', { name: 'Export' })[0];

    await act(async () => {
      fireEvent.click(destinationButton);
    });

    await waitFor(() => {
      expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/two.jpg']);
    });
  });

  it('opens a context menu with shortcut hints on right click', async () => {
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

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const imageCanvas = document.createElement('div');
    imageCanvas.className = 'image-canvas';
    container.appendChild(imageCanvas);

    fireEvent.contextMenu(imageCanvas);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveTextContent('Selection');
    expect(menu).toHaveTextContent('Copy');
    expect(menu).toHaveTextContent('Open');
    expect(menu).toHaveTextContent('Danger');
    expect(within(menu).getByRole('menuitem', { name: /Copy Filename/i })).toBeInTheDocument();
    expect(menu).toHaveTextContent('Ctrl+Shift+C');
    expect(menu).toHaveTextContent('Delete');
  });

  it('copies the filename from the context menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

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

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const imageCanvas = document.createElement('div');
    imageCanvas.className = 'image-canvas';
    container.appendChild(imageCanvas);

    fireEvent.contextMenu(imageCanvas);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Copy Filename/i }));
    });

    expect(writeText).toHaveBeenCalledWith('photo.jpg');
    await waitFor(() => {
      expect(useToastStore.getState().toasts).toContainEqual(
        expect.objectContaining({
          title: 'Filename copied',
          kind: 'success',
          message: 'photo.jpg',
        })
      );
    });
  });

  it('keeps the context menu action clickable through pointerdown', async () => {
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

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const imageCanvas = document.createElement('div');
    imageCanvas.className = 'image-canvas';
    container.appendChild(imageCanvas);

    fireEvent.contextMenu(imageCanvas);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    const markAction = within(menu).getByRole('menuitem', { name: /Mark Current Image/i });

    fireEvent.pointerDown(markAction);
    fireEvent.click(markAction);

    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/photo.jpg']);
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Image actions' })).not.toBeInTheDocument();
    });
  });

  it('keeps context menu actions pinned to the image that was right-clicked', async () => {
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
          path: 'C:/Images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const imageCanvas = document.createElement('div');
    imageCanvas.className = 'image-canvas';
    container.appendChild(imageCanvas);

    fireEvent.contextMenu(imageCanvas);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    useViewerStore.getState().setCurrentIndex(1);

    const markAction = within(menu).getByRole('menuitem', { name: /Mark Current Image/i });
    fireEvent.click(markAction);

    expect(useViewerStore.getState().currentImagePath).toBe('C:/Images/next.jpg');
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/photo.jpg']);
  });

  it('shows a compare zoom lock toggle only in compare mode', () => {
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
          path: 'C:/Images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    const { rerender } = render(<ViewerChrome {...defaultProps} />);
    expect(screen.queryByLabelText('Lock compare zoom')).not.toBeInTheDocument();

    useViewerStore.getState().enterCompareMode();
    rerender(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Lock compare zoom'));
    expect(useViewerStore.getState().isCompareZoomLocked).toBe(true);
    expect(screen.getByLabelText('Unlock compare zoom')).toBeInTheDocument();
  });

  it('binds thumbnail-strip context menu actions to the clicked thumbnail path', async () => {
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
          path: 'C:/Images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
    });

    const { container } = render(<ViewerChrome {...defaultProps} />);
    const thumbnailStrip = document.createElement('div');
    thumbnailStrip.className = 'thumbnail-strip';
    const thumbnailItem = document.createElement('div');
    thumbnailItem.className = 'thumbnail-item';
    thumbnailItem.setAttribute('data-image-path', 'C:/Images/next.jpg');
    thumbnailStrip.appendChild(thumbnailItem);
    container.appendChild(thumbnailStrip);

    fireEvent.contextMenu(thumbnailItem);

    const menu = await screen.findByRole('menu', { name: 'Image actions' });
    const markAction = within(menu).getByRole('menuitem', { name: /Mark Current Image/i });
    fireEvent.click(markAction);

    expect(useViewerStore.getState().currentImagePath).toBe('C:/Images/photo.jpg');
    expect(useViewerStore.getState().markedPaths).toEqual(['C:/Images/next.jpg']);
  });

  it('keeps marked actions tucked away until opened', () => {
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
      markedPaths: ['C:/Images/photo.jpg'],
    });

    render(<ViewerChrome {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Marked image actions' })).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Marked image actions' })).not.toBeInTheDocument();
  });

  it('presents marked actions as grouped commands with non-interactive status text', async () => {
    const longDestinationLabel =
      'A very long client export folder name that should not inherit fixed menu no-wrap styling';
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
          path: 'C:/Images/next.jpg',
          file_name: 'next.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '2',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/photo.jpg', 'C:/Images/next.jpg'],
    });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        quickDestinations: [
          { id: 'long-export', label: longDestinationLabel, path: 'D:/Very Long Export' },
        ],
      },
    }));

    render(<ViewerChrome {...defaultProps} />);

    const markedActionsTrigger = screen.getByRole('button', { name: 'Marked image actions' });
    expect(markedActionsTrigger).toHaveTextContent('More');
    expect(markedActionsTrigger).not.toHaveTextContent('2 marked');

    fireEvent.click(markedActionsTrigger);
    const markedActions = await screen.findByRole('toolbar', { name: 'Marked image actions' });
    const markedCount = within(markedActions).getByText('2 marked');

    expect(markedCount.closest('button, summary')).toBeNull();
    expect(within(markedActions).getByText('Current image marked')).toBeInTheDocument();
    expect(within(markedActions).getByText('Marking')).toBeInTheDocument();
    expect(within(markedActions).getByText('Navigate')).toBeInTheDocument();
    expect(within(markedActions).getByText('Files')).toBeInTheDocument();
    expect(within(markedActions).getByText('Danger')).toBeInTheDocument();
    expect(
      within(markedActions).getByRole('button', { name: 'Mark All Visible Images' })
    ).toBeInTheDocument();
    expect(
      within(markedActions).getByRole('button', { name: 'Go to Last Marked' })
    ).toBeInTheDocument();
    const copyToFolder = within(markedActions).getByLabelText(
      'Copy marked images to a destination'
    );
    expect(copyToFolder).toHaveTextContent('Copy to Folder...');
    expect(copyToFolder).toHaveClass('marked-actions-menu-item');
    expect(
      within(markedActions).getByLabelText('Move marked images to a destination')
    ).toHaveTextContent('Move to Folder...');
    expect(within(markedActions).getByRole('button', { name: 'Delete Marked' })).toHaveClass(
      'top-bar-menu-item--danger'
    );

    fireEvent.click(copyToFolder);
    within(markedActions)
      .getAllByRole('button', { name: longDestinationLabel })
      .forEach((destinationButton) => {
        expect(destinationButton).not.toHaveClass('marked-actions-menu-item');
      });
  });

  it('keeps marked Copy and Move destination menus mutually exclusive', async () => {
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
      markedPaths: ['C:/Images/photo.jpg'],
    });
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        quickDestinations: [{ id: 'export', label: 'Export', path: 'D:/Export' }],
      },
    }));

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const markedActions = await screen.findByRole('toolbar', { name: 'Marked image actions' });
    const copySummary = within(markedActions).getByLabelText('Copy marked images to a destination');
    const moveSummary = within(markedActions).getByLabelText('Move marked images to a destination');
    const copyMenu = copySummary.closest('details');
    const moveMenu = moveSummary.closest('details');

    expect(copySummary).toHaveAttribute('aria-expanded', 'false');
    expect(moveSummary).toHaveAttribute('aria-expanded', 'false');
    expect(copyMenu).not.toHaveAttribute('open');
    expect(moveMenu).not.toHaveAttribute('open');

    fireEvent.click(copySummary);

    expect(copySummary).toHaveAttribute('aria-expanded', 'true');
    expect(moveSummary).toHaveAttribute('aria-expanded', 'false');
    expect(copyMenu).toHaveAttribute('open');
    expect(moveMenu).not.toHaveAttribute('open');

    fireEvent.click(moveSummary);

    expect(copySummary).toHaveAttribute('aria-expanded', 'false');
    expect(moveSummary).toHaveAttribute('aria-expanded', 'true');
    expect(copyMenu).not.toHaveAttribute('open');
    expect(moveMenu).toHaveAttribute('open');
  });

  it('jumps to the most recently marked image from the marked actions menu', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/first.jpg',
      images: [
        {
          path: 'C:/Images/first.jpg',
          file_name: 'first.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/second.jpg',
          file_name: 'second.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
        {
          path: 'C:/Images/last.jpg',
          file_name: 'last.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1',
        },
      ],
      currentIndex: 0,
      markedPaths: ['C:/Images/second.jpg', 'C:/Images/last.jpg'],
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Go to Last Marked' }));

    expect(useViewerStore.getState().currentIndex).toBe(2);
    expect(useViewerStore.getState().currentImagePath).toBe('C:/Images/last.jpg');
    expect(screen.queryByRole('toolbar', { name: 'Marked image actions' })).not.toBeInTheDocument();
  });

  it('closes the viewer bulk transfer menu when clicking outside', async () => {
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
      markedPaths: ['C:/Images/photo.jpg'],
    });

    render(<ViewerChrome {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Marked image actions' }));
    const bulkToolbar = await screen.findByRole('toolbar', { name: 'Marked image actions' });
    const bulkCopyMenu = bulkToolbar.querySelector('details') as HTMLDetailsElement;
    const bulkCopySummary = bulkCopyMenu.querySelector('summary') as HTMLElement;

    fireEvent.click(bulkCopySummary);
    expect(bulkCopyMenu.open).toBe(true);

    fireEvent.pointerDown(document.body);
    expect(bulkCopyMenu.open).toBe(false);
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

  it('queues a high-quality scaled copy without running it immediately', async () => {
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
      fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    });

    expect(scaleSpy).not.toHaveBeenCalled();
    expect(useEditQueueStore.getState().jobs).toMatchObject([
      {
        kind: 'scaled-copy',
        sourcePath: 'C:/Images/photo.jpg',
        outputPath: 'C:/Images/photo-scaled.jpg',
        width: 600,
        height: 400,
        smoothing: 20,
        sharpening: 30,
        status: 'queued',
      },
    ]);
    expect(screen.getByRole('region', { name: 'Editing queue' })).toBeInTheDocument();
  });

  it('rejects queued exports that reuse an active output path', async () => {
    useEditQueueStore.getState().enqueueJob({
      kind: 'scaled-copy',
      sourcePath: 'C:/Images/other.jpg',
      outputPath: 'C:/Images/photo-scaled.jpg',
      width: 600,
      height: 400,
      smoothing: 0,
      sharpening: 0,
    });
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
    vi.mocked(save).mockResolvedValue('C:/Images/photo-scaled.jpg');

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
      fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    });

    expect(useEditQueueStore.getState().jobs).toHaveLength(1);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Editing Queue',
        kind: 'error',
        message: expect.stringContaining('active queued export'),
      })
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

    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        title: 'Scale Copy',
        kind: 'error',
        message: expect.stringContaining('Scaled export can save JPEG'),
      })
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
    expect(useToastStore.getState().toasts).toHaveLength(0);
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

  it('queues a cropped copy with the current crop rectangle', async () => {
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      isCropMode: true,
      cropRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
      rotation: 90,
    });
    vi.mocked(save).mockResolvedValue('C:/Images/photo-cropped.jpg');
    const cropSpy = vi.spyOn(tauriCommands, 'saveCroppedCopy').mockResolvedValue(undefined);

    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true });
    const container = document.createElement('div');
    container.className = 'image-canvas';
    container.appendChild(image);
    document.body.appendChild(container);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Queue cropped copy'));
    });

    expect(cropSpy).not.toHaveBeenCalled();
    expect(useEditQueueStore.getState().jobs).toMatchObject([
      {
        kind: 'cropped-copy',
        sourcePath: 'C:/Images/photo.jpg',
        outputPath: 'C:/Images/photo-cropped.jpg',
        cropRect: { x: 120, y: 160, width: 480, height: 240 },
        rotationDegrees: 90,
        status: 'queued',
      },
    ]);
  });

  it('saves pending crop edits as a new file when copy mode is configured', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        cropSaveMode: 'copy',
      },
    }));
    useViewerStore.setState({
      currentImagePath: 'C:/Images/photo.jpg',
      pendingEditsByPath: {
        'C:/Images/photo.jpg': {
          rotationDegrees: 0,
          cropRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
          pendingCropPreview: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
          updatedAt: 1,
          history: [],
        },
      },
      cropRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
      pendingCropPreview: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
    });
    vi.mocked(save).mockResolvedValue('C:/Images/photo-cropped.jpg');
    const saveCopySpy = vi.spyOn(tauriCommands, 'saveCroppedCopy').mockResolvedValue(undefined);
    const overwriteSpy = vi.spyOn(tauriCommands, 'overwriteWithCrop').mockResolvedValue(undefined);

    render(<ViewerChrome {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save pending edits'));
    });

    expect(saveCopySpy).toHaveBeenCalledWith(
      'C:/Images/photo.jpg',
      { x: 120, y: 160, width: 480, height: 240 },
      'C:/Images/photo-cropped.jpg',
      0
    );
    expect(overwriteSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(useViewerStore.getState().pendingEditsByPath['C:/Images/photo.jpg']).toBeUndefined();
    });
    expect(useViewerStore.getState().cropRect).toBeNull();
    expect(useViewerStore.getState().pendingCropPreview).toBeNull();
  });

  it('refreshes the metadata panel after a successful crop overwrite', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        cropSaveMode: 'overwrite',
      },
    }));
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
      expect(tauriCommands.getImageMetadata).toHaveBeenCalledTimes(3);
      expect(tauriCommands.getExifMetadata).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps pending crop edits when save pending edits is canceled at confirmation', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        cropSaveMode: 'overwrite',
      },
    }));
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
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        cropSaveMode: 'overwrite',
      },
    }));
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

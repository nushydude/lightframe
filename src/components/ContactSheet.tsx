import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type UIEvent,
} from 'react';
import { getRuntime } from '../services/runtime/runtime';
import { useViewerStore } from '../state/viewerStore';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';
import {
  evictThumbnailsExcept,
  getCachedThumbnail,
  preloadThumbnails,
} from '../services/thumbnailCache';
import { closeSecondaryWindow, openSecondaryWindow } from '../services/tauriCommands';
import { useThumbnailRefreshSignal } from '../hooks/useThumbnailRefreshSignal';
import { useProjectorState } from '../hooks/useProjectorState';
import { FolderSortMenu } from './FolderSortMenu';
import { selectRangePaths, toggleSelectionPath } from '../services/contactSheetSelection';
import {
  buildContactSheetResultIndex,
  normalizeContactSheetPath,
  normalizeContactSheetQuery,
  searchContactSheetImages,
  type ContactSheetSearchResult,
} from '../services/contactSheetSearch';
import {
  chooseQuickDestinationFolder,
  copyCurrentImage,
  copyCurrentImagePath,
  deleteImages,
  deleteCurrentImage,
  openCurrentImageInEditor,
  revealCurrentImage,
  showTransferResultMessage,
  transferImagesToDestination,
} from '../services/viewerActions';
import { getCurationFilterCountLabel } from '../services/curationFilter';
import type { QuickDestination } from '../types/settings';
import { CurationFilterMenu } from './CurationFilterMenu';
import { ToolbarIcon } from './ToolbarIcon';
import { isInteractiveTargetOutsideGrid } from '../services/keyboardTarget';

const GRID_ITEM_SIZE = 140;
const GRID_GAP = 20;
const GRID_LABEL_HEIGHT = 20;
const GRID_ROW_HEIGHT = GRID_ITEM_SIZE + GRID_GAP + GRID_LABEL_HEIGHT;
const GRID_OVERSCAN_ROWS = 3;

interface ContactSheetProps {
  onExitGridView: () => Promise<boolean>;
  onGoHome: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onRefreshFolder: () => void;
  onStartSlideshow: () => void | Promise<void>;
}

/**
 * A full-screen grid view of all images in the current folder.
 * Windowed rendering keeps large folders responsive.
 */
// fallow-ignore-next-line complexity -- contact-sheet interaction orchestration
export function ContactSheet({
  onExitGridView,
  onGoHome,
  onOpenFile,
  onOpenFolder,
  onRefreshFolder,
  onStartSlideshow,
}: ContactSheetProps) {
  const images = useViewerStore((state) => state.images);
  const currentIndex = useViewerStore((state) => state.currentIndex);
  const isFullscreen = useViewerStore((state) => state.isFullscreen);
  const rotation = useViewerStore((state) => state.rotation);
  const pendingCropPreview = useViewerStore((state) => state.pendingCropPreview);
  const curationFilter = useViewerStore((state) => state.curationFilter);
  const setCurrentIndex = useViewerStore((state) => state.setCurrentIndex);
  const setFullscreen = useViewerStore((state) => state.setFullscreen);
  const setViewMode = useViewerStore((state) => state.setViewMode);
  const setCurationFilter = useViewerStore((state) => state.setCurationFilter);
  const setShowSettings = useViewerStore((state) => state.setShowSettings);
  const enterCompareMode = useViewerStore((state) => state.enterCompareMode);
  const enterCropMode = useViewerStore((state) => state.enterCropMode);
  const curationByPath = useCurationStore((state) => state.curationByPath);
  const toggleFavorite = useCurationStore((state) => state.toggleFavorite);
  const setFavoriteForPaths = useCurationStore((state) => state.setFavoriteForPaths);
  const setRatingForPaths = useCurationStore((state) => state.setRatingForPaths);
  const quickDestinations = useSettingsStore((state) => state.settings.quickDestinations);
  const externalEditorPath = useSettingsStore((state) => state.settings.externalEditorPath);
  const externalEditorLabel = useSettingsStore((state) => state.settings.externalEditorLabel);
  const openProjectorInGridView = useSettingsStore(
    (state) => state.settings.openProjectorInGridView
  );
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [columns, setColumns] = useState(1);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkCurationPending, setBulkCurationPending] = useState(false);
  const { isProjectorOpen, refreshProjectorState } = useProjectorState();

  const contactSheetRootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const bulkCurationPendingRef = useRef(false);
  const { handleThumbnailLoaded, isThumbnailConsumerActive } = useThumbnailRefreshSignal();

  const normalizedQuery = useMemo(() => normalizeContactSheetQuery(searchQuery), [searchQuery]);
  const searchResults = useMemo(
    () => searchContactSheetImages(images, normalizedQuery),
    [images, normalizedQuery]
  );
  const resultIndexByPath = useMemo(
    () => buildContactSheetResultIndex(searchResults),
    [searchResults]
  );
  const displayedImages = useMemo(() => searchResults.map(({ image }) => image), [searchResults]);
  const currentResultIndex =
    resultIndexByPath.get(normalizeContactSheetPath(images[currentIndex]?.path ?? '')) ?? -1;
  const totalRows = Math.ceil(searchResults.length / columns);
  const activeRow = currentResultIndex >= 0 ? Math.floor(currentResultIndex / columns) : 0;
  const visibleRange = useMemo(() => {
    const firstRow = Math.max(0, Math.floor(scrollTop / GRID_ROW_HEIGHT) - GRID_OVERSCAN_ROWS);
    const rowCount = Math.ceil(viewportHeight / GRID_ROW_HEIGHT) + GRID_OVERSCAN_ROWS * 2;
    const lastRow = Math.min(totalRows, firstRow + rowCount);

    return {
      startIndex: firstRow * columns,
      endIndex: Math.min(searchResults.length, lastRow * columns),
      topHeight: firstRow * GRID_ROW_HEIGHT,
      bottomHeight: Math.max(0, (totalRows - lastRow) * GRID_ROW_HEIGHT),
    };
  }, [columns, searchResults.length, scrollTop, totalRows, viewportHeight]);

  const visibleResults = useMemo(
    () => searchResults.slice(visibleRange.startIndex, visibleRange.endIndex),
    [searchResults, visibleRange.endIndex, visibleRange.startIndex]
  );
  const currentImagePath = currentIndex >= 0 ? (images[currentIndex]?.path ?? null) : null;
  const currentCuration = currentImagePath ? curationByPath[currentImagePath] : undefined;
  const isFavorite = Boolean(currentCuration?.favorite);
  const canEnterCompareMode = images.length > 1;
  const canStartSlideshow = images.length > 1;
  const cropDisabledByRotation = rotation !== 0;
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const hasSelection = selectedPaths.length > 0;

  useLayoutEffect(() => {
    const activeElement = document.activeElement;
    if (
      activeElement === searchInputRef.current ||
      (activeElement !== document.body &&
        !gridRef.current?.contains(activeElement) &&
        !activeElement?.matches('[role="gridcell"]'))
    ) {
      return;
    }

    const focusPath = searchResults[currentResultIndex]?.image.path ?? displayedImages[0]?.path;
    const activeCell = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>('[role="gridcell"]') ?? []
    ).find((cell) => cell.dataset.imagePath === focusPath);
    activeCell?.focus({ preventScroll: true });
  }, [
    currentResultIndex,
    displayedImages,
    searchResults,
    visibleRange.endIndex,
    visibleRange.startIndex,
  ]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const updateMetrics = () => {
      const availableWidth = Math.min(1400, content.clientWidth);
      setColumns(
        Math.max(1, Math.floor((availableWidth + GRID_GAP) / (GRID_ITEM_SIZE + GRID_GAP)))
      );
      setViewportHeight(content.clientHeight);
      setScrollTop(content.scrollTop);
    };

    updateMetrics();
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(content);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contentRef.current || currentIndex < 0) return;

    const targetTop = activeRow * GRID_ROW_HEIGHT;
    const targetBottom = targetTop + GRID_ROW_HEIGHT;
    const viewTop = contentRef.current.scrollTop;
    const viewBottom = viewTop + contentRef.current.clientHeight;

    if (targetTop < viewTop || targetBottom > viewBottom) {
      const nextScrollTop = Math.max(0, targetTop - GRID_ROW_HEIGHT);
      contentRef.current.scrollTo({
        top: nextScrollTop,
        behavior: 'auto',
      });
      setScrollTop(nextScrollTop);
    }
  }, [activeRow, currentIndex]);

  useEffect(() => {
    preloadThumbnails(
      visibleResults.map(({ image }) => ({
        path: image.path,
        sizeBytes: image.size_bytes,
        modifiedAt: image.modified_at,
      })),
      {
        onLoaded: handleThumbnailLoaded,
        isActive: isThumbnailConsumerActive,
      }
    );

    const keepStart = Math.max(0, visibleRange.startIndex - columns * GRID_OVERSCAN_ROWS * 4);
    const keepEnd = Math.min(
      searchResults.length,
      visibleRange.endIndex + columns * GRID_OVERSCAN_ROWS * 4
    );
    const keepPaths = new Set(
      searchResults.slice(keepStart, keepEnd).map(({ image }) => image.path)
    );
    evictThumbnailsExcept(keepPaths);
  }, [
    columns,
    handleThumbnailLoaded,
    images,
    isThumbnailConsumerActive,
    searchResults,
    visibleResults,
    visibleRange.endIndex,
    visibleRange.startIndex,
  ]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const validPaths = new Set(images.map((image) => image.path));
    setSelectedPaths((current) => current.filter((path) => validPaths.has(path)));
  }, [images]);

  useEffect(() => {
    const visiblePaths = new Set(searchResults.map(({ image }) => image.path));
    setSelectedPaths((current) => current.filter((path) => visiblePaths.has(path)));
    setLastSelectedIndex(null);
    setScrollTop(0);
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [normalizedQuery, searchResults]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    if (scrollRafRef.current !== null) return;

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop(nextScrollTop);
    });
  };

  const handlePageScroll = (event: KeyboardEvent) => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return;

    const content = contentRef.current;
    if (!content) return;

    event.preventDefault();
    event.stopPropagation();

    const pageHeight = content.clientHeight || GRID_ROW_HEIGHT;
    const direction = event.key === 'PageDown' ? 1 : -1;
    const maxScrollTop = Math.max(0, content.scrollHeight - content.clientHeight);
    const nextScrollTop = Math.max(
      0,
      Math.min(maxScrollTop, content.scrollTop + direction * pageHeight)
    );

    content.scrollTo({
      top: nextScrollTop,
      behavior: 'auto',
    });
    setScrollTop(nextScrollTop);
  };

  const handleSelect = useCallback(
    (result: ContactSheetSearchResult) => {
      setCurrentIndex(result.sourceIndex);
      setViewMode('viewer');
    },
    [setCurrentIndex, setViewMode]
  );

  const handleSelectForProjector = (result: ContactSheetSearchResult) => {
    setCurrentIndex(result.sourceIndex);
  };

  const handleGridItemClick = (
    event: MouseEvent<HTMLButtonElement>,
    resultIndex: number,
    result: ContactSheetSearchResult
  ) => {
    if (event.shiftKey && lastSelectedIndex !== null) {
      setSelectedPaths((current) =>
        selectRangePaths(displayedImages, lastSelectedIndex, resultIndex, current)
      );
      setLastSelectedIndex(resultIndex);
      setCurrentIndex(result.sourceIndex);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedPaths((current) => toggleSelectionPath(current, result.image.path));
      setLastSelectedIndex(resultIndex);
      setCurrentIndex(result.sourceIndex);
      return;
    }

    setSelectedPaths([result.image.path]);
    setLastSelectedIndex(resultIndex);
    if (isProjectorOpen) {
      handleSelectForProjector(result);
      return;
    }

    handleSelect(result);
  };

  const removeMovedImages = (paths: string[]) => {
    useViewerStore.getState().removeImagesByPaths(paths);
  };

  const handleBulkTransfer = async (destination: QuickDestination, mode: 'copy' | 'move') => {
    const targetPaths =
      selectedPaths.length > 0
        ? selectedPaths
        : currentIndex >= 0
          ? [images[currentIndex].path]
          : [];
    if (targetPaths.length === 0) {
      return;
    }

    const result = await transferImagesToDestination(targetPaths, destination, mode);
    if (mode === 'move') {
      const movedPaths = new Set(result.successes.map((success) => success.sourcePath));
      removeMovedImages([...movedPaths]);
      setSelectedPaths((current) => current.filter((path) => !movedPaths.has(path)));
    }
    showTransferResultMessage(result, destination, mode);
  };

  const handleChooseTransferFolder = async (mode: 'copy' | 'move') => {
    const destination = await chooseQuickDestinationFolder();
    if (!destination) {
      return;
    }

    await handleBulkTransfer(destination, mode);
  };

  const handleSelectAll = () => {
    setSelectedPaths(displayedImages.map((image) => image.path));
    setLastSelectedIndex(Math.max(0, currentResultIndex));
  };

  const handleClearSelection = () => {
    setSelectedPaths([]);
    setLastSelectedIndex(null);
  };

  const runBulkCurationAction = async (action: () => Promise<void>) => {
    if (!hasSelection || bulkCurationPendingRef.current) {
      return;
    }

    bulkCurationPendingRef.current = true;
    setBulkCurationPending(true);
    try {
      await action();
    } finally {
      bulkCurationPendingRef.current = false;
      setBulkCurationPending(false);
    }
  };

  const handleBulkFavorite = async (favorite: boolean) => {
    await runBulkCurationAction(() => setFavoriteForPaths([...selectedPaths], favorite));
  };

  const handleBulkRating = async (rating: number) => {
    await runBulkCurationAction(() => setRatingForPaths([...selectedPaths], rating));
  };

  const handleCopyCurrent = async () => {
    await copyCurrentImage(currentImagePath);
  };

  const handleCopyCurrentPath = async () => {
    await copyCurrentImagePath(currentImagePath);
  };

  const handleDeleteCurrent = useCallback(async () => {
    await deleteCurrentImage({
      currentImagePath,
      currentIndex,
      removeImage: useViewerStore.getState().removeImage,
    });
  }, [currentImagePath, currentIndex]);

  const handleDeleteSelected = async () => {
    if (!hasSelection) {
      return;
    }

    await deleteImages({
      imagePaths: selectedPaths,
      removeImagesByPaths: useViewerStore.getState().removeImagesByPaths,
    });
    setSelectedPaths((current) =>
      current.filter((path) =>
        useViewerStore.getState().images.some((image) => image.path === path)
      )
    );
  };

  const handleOpenInEditor = async () => {
    await openCurrentImageInEditor(currentImagePath, externalEditorPath, externalEditorLabel);
  };

  const handleReveal = async () => {
    await revealCurrentImage(currentImagePath);
  };

  const handleToggleFavorite = async () => {
    if (!currentImagePath) {
      return;
    }

    await toggleFavorite(currentImagePath);
  };

  const handleToggleFullscreen = async () => {
    try {
      const appWindow = getRuntime().window;
      const nextFullscreen = !isFullscreen;
      await appWindow.setFullscreen(nextFullscreen);
      setFullscreen(nextFullscreen);
    } catch (err) {
      console.error('Failed to toggle fullscreen:', err);
    }
  };

  const handleToggleCrop = () => {
    if (cropDisabledByRotation) {
      return;
    }

    if (pendingCropPreview) {
      useViewerStore.getState().clearCropPreview();
    }
    void onExitGridView().then((didExit) => {
      if (!didExit) {
        return;
      }
      enterCropMode();
    });
  };

  const handleStartSlideshow = async () => {
    const didExit = await onExitGridView();
    if (!didExit) {
      return;
    }

    await onStartSlideshow();
  };

  const renderQuickDestinationMenu = (mode: 'copy' | 'move') => (
    <div className="top-bar-submenu-panel">
      {quickDestinations.length === 0 ? (
        <span className="top-bar-menu-empty">
          No destinations configured yet. Use Choose Folder or add saved folders in Settings.
        </span>
      ) : (
        quickDestinations.map((destination) => (
          <button
            key={destination.id}
            className="top-bar-menu-item"
            onClick={() => void handleBulkTransfer(destination, mode)}
            type="button"
          >
            {destination.label}
          </button>
        ))
      )}
      <button
        className="top-bar-menu-item"
        onClick={() => void handleChooseTransferFolder(mode)}
        type="button"
      >
        Choose Folder...
      </button>
      <button className="top-bar-menu-item" onClick={() => setShowSettings(true)} type="button">
        Manage Saved Folders
      </button>
    </div>
  );

  const renderBulkQuickDestinationMenu = (mode: 'copy' | 'move') => (
    <details className="top-bar-submenu contact-sheet-bulk-menu">
      <summary
        className="top-bar-menu-item"
        aria-label={`${mode === 'copy' ? 'Copy' : 'Move'} selected images`}
      >
        {mode === 'copy' ? 'Copy To' : 'Move To'}
      </summary>
      {renderQuickDestinationMenu(mode)}
    </details>
  );

  const handleCloseProjector = async () => {
    await closeSecondaryWindow();
    await refreshProjectorState();
  };

  const handleToggleProjector = async () => {
    if (isProjectorOpen) {
      await handleCloseProjector();
      return;
    }

    await openSecondaryWindow();
    if (openProjectorInGridView && useViewerStore.getState().viewMode !== 'grid') {
      useViewerStore.getState().setViewMode('grid');
    }
    await refreshProjectorState();
  };

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const menuRoot = target.closest('.top-bar-menu, .top-bar-submenu');
      if (menuRoot && contactSheetRootRef.current?.contains(menuRoot)) {
        return;
      }

      contactSheetRootRef.current
        ?.querySelectorAll('details[open]')
        .forEach((menu) => ((menu as HTMLDetailsElement).open = false));
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  useEffect(() => {
    // fallow-ignore-next-line complexity -- keyboard grid navigation boundary
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isSearchInput = target === searchInputRef.current;

      if (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (isSearchInput && e.key !== 'Escape') {
        return;
      }

      if (e.key === 'Escape' && normalizedQuery !== '') {
        e.preventDefault();
        setSearchQuery('');
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        void onExitGridView();
        return;
      }

      if (isInteractiveTargetOutsideGrid(e.target, gridRef.current)) return;
      if (e.key === 'Enter') {
        if (target?.closest('[role="gridcell"]')) {
          e.preventDefault();
          const result = searchResults[currentResultIndex];
          if (result) handleSelect(result);
        }
        return;
      }

      const resultIndex = currentResultIndex >= 0 ? currentResultIndex : 0;
      const moveTo = (destination: number) => {
        const result = searchResults[destination];
        if (!result) return;
        if (e.shiftKey) {
          const anchor = lastSelectedIndex ?? resultIndex;
          setSelectedPaths((current) =>
            selectRangePaths(displayedImages, anchor, destination, current)
          );
          setLastSelectedIndex(anchor);
        }
        setCurrentIndex(result.sourceIndex);
      };
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveTo(Math.min(searchResults.length - 1, resultIndex + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveTo(Math.max(0, resultIndex - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveTo(Math.min(searchResults.length - 1, resultIndex + columns));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveTo(Math.max(0, resultIndex - columns));
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (searchResults[0]) setCurrentIndex(searchResults[0].sourceIndex);
      } else if (e.key === 'End') {
        e.preventDefault();
        const result = searchResults[searchResults.length - 1];
        if (result) setCurrentIndex(result.sourceIndex);
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        handlePageScroll(e);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        void handleDeleteCurrent();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    columns,
    currentResultIndex,
    currentIndex,
    displayedImages,
    handleDeleteCurrent,
    handleSelect,
    normalizedQuery,
    onExitGridView,
    searchResults,
    lastSelectedIndex,
    setCurrentIndex,
  ]);

  return (
    <div
      className="contact-sheet-overlay"
      ref={contactSheetRootRef}
      data-testid="grid-root"
      data-visible-count={searchResults.length}
      data-total-count={images.length}
    >
      <div className="contact-sheet-header">
        <div className="header-left">
          <h2>Contact Sheet</h2>
          <span className="image-count">
            {normalizedQuery
              ? `${searchResults.length} of ${images.length} images`
              : `${images.length} ${getCurationFilterCountLabel(curationFilter)}`}
          </span>
          {selectedPaths.length > 0 && (
            <span className="image-count">{selectedPaths.length} selected</span>
          )}
        </div>
        <div className="contact-sheet-search">
          <label htmlFor="contact-sheet-search-input">Search filenames</label>
          <div className="contact-sheet-search-control">
            <input
              ref={searchInputRef}
              id="contact-sheet-search-input"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search filenames"
              aria-label="Search filenames"
            />
            {searchQuery !== '' && (
              <button
                type="button"
                className="contact-sheet-search-clear"
                aria-label="Clear filename search"
                onClick={() => {
                  setSearchQuery('');
                  searchInputRef.current?.focus();
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="top-bar-right header-actions">
          <div className="top-bar-group" aria-label="Navigation actions">
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={onGoHome}
              data-tooltip="Return to start screen"
              title="Return to start screen"
              aria-label="Return to start screen"
              id="btn-home-grid"
            >
              <span className="top-bar-btn-icon">⌂</span>
              <span className="top-bar-btn-label">Start</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={onOpenFile}
              data-tooltip="Open file (Ctrl+O)"
              title="Open file (Ctrl+O)"
              aria-label="Open file"
            >
              <span className="top-bar-btn-icon">📄</span>
              <span className="top-bar-btn-label">Open</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={onOpenFolder}
              data-tooltip="Open folder"
              title="Open folder"
              aria-label="Open folder"
            >
              <span className="top-bar-btn-icon">📁</span>
              <span className="top-bar-btn-label">Folder</span>
            </button>
          </div>

          <div className="top-bar-separator" aria-hidden="true" />

          <div className="top-bar-group" aria-label="Primary actions">
            <button
              className={`top-bar-btn top-bar-btn--labeled has-tooltip ${isFavorite ? 'active' : ''}`}
              onClick={() => void handleToggleFavorite()}
              data-tooltip={isFavorite ? 'Remove favorite (F)' : 'Mark as favorite (F)'}
              title={isFavorite ? 'Remove favorite (F)' : 'Mark as favorite (F)'}
              aria-label="Toggle favorite"
            >
              <span className="top-bar-btn-icon">
                <ToolbarIcon name="favorite" />
              </span>
              <span className="top-bar-btn-label">Favorite</span>
            </button>
            <CurationFilterMenu currentFilter={curationFilter} onSelect={setCurationFilter} />
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={() => void handleStartSlideshow()}
              data-tooltip="Start slideshow (F5)"
              title="Start slideshow (F5)"
              aria-label="Start slideshow"
              disabled={!canStartSlideshow}
            >
              <span className="top-bar-btn-icon">
                <ToolbarIcon name="slideshow" />
              </span>
              <span className="top-bar-btn-label">Slideshow</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={() => void handleToggleFullscreen()}
              data-tooltip="Toggle fullscreen (F11)"
              title="Toggle fullscreen (F11)"
              aria-label="Toggle fullscreen"
            >
              <span className="top-bar-btn-icon">{isFullscreen ? '🗗' : '⛶'}</span>
              <span className="top-bar-btn-label">Full</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip active"
              onClick={() => void onExitGridView()}
              data-tooltip="Grid view (G)"
              title="Grid view (G)"
              aria-label="Toggle grid view"
            >
              <span className="top-bar-btn-icon">▦</span>
              <span className="top-bar-btn-label">Grid</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={() => {
                if (!canEnterCompareMode) {
                  return;
                }
                enterCompareMode();
              }}
              title={
                canEnterCompareMode ? 'Compare view' : 'Compare view requires at least two images'
              }
              data-tooltip={
                canEnterCompareMode ? 'Compare view' : 'Compare view requires at least two images'
              }
              aria-label="Toggle compare view"
              disabled={!canEnterCompareMode}
            >
              <span className="top-bar-btn-icon">≡</span>
              <span className="top-bar-btn-label">Compare</span>
            </button>
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={handleToggleCrop}
              data-tooltip={
                cropDisabledByRotation
                  ? 'Crop is unavailable while rotation preview is active'
                  : 'Crop image'
              }
              title={
                cropDisabledByRotation
                  ? 'Crop is unavailable while rotation preview is active'
                  : 'Crop image'
              }
              aria-label="Toggle crop mode"
              disabled={cropDisabledByRotation}
            >
              <span className="top-bar-btn-icon">✂</span>
              <span className="top-bar-btn-label">Crop</span>
            </button>
            <details className="top-bar-menu">
              <summary
                className="top-bar-btn top-bar-btn--labeled has-tooltip"
                aria-label="More actions"
                data-tooltip="More actions"
                title="More actions"
              >
                <span className="top-bar-btn-icon">...</span>
                <span className="top-bar-btn-label">More</span>
              </summary>
              <div className="top-bar-menu-panel top-bar-menu-panel--stacked">
                <FolderSortMenu />
                <button className="top-bar-menu-item" onClick={onRefreshFolder} type="button">
                  Refresh
                </button>
                <button
                  className="top-bar-menu-item"
                  onClick={() => void handleReveal()}
                  type="button"
                  disabled={!currentImagePath}
                >
                  Reveal
                </button>
                <button
                  className="top-bar-menu-item"
                  onClick={() => void handleCopyCurrent()}
                  type="button"
                  disabled={!currentImagePath}
                >
                  Copy
                </button>
                <button
                  className="top-bar-menu-item"
                  onClick={() => void handleCopyCurrentPath()}
                  type="button"
                  disabled={!currentImagePath}
                >
                  Copy Path
                </button>
                <details className="top-bar-submenu">
                  <summary className="top-bar-menu-item" aria-label="Copy image to destination">
                    Copy To
                  </summary>
                  {renderQuickDestinationMenu('copy')}
                </details>
                <details className="top-bar-submenu">
                  <summary className="top-bar-menu-item" aria-label="Move image to destination">
                    Move To
                  </summary>
                  {renderQuickDestinationMenu('move')}
                </details>
                <button
                  className="top-bar-menu-item"
                  onClick={() => void handleOpenInEditor()}
                  type="button"
                  disabled={!currentImagePath}
                >
                  {externalEditorLabel ? `Edit in ${externalEditorLabel}` : 'Edit'}
                </button>
                <button
                  className="top-bar-menu-item"
                  onClick={() => void handleDeleteCurrent()}
                  type="button"
                  disabled={!currentImagePath}
                >
                  Delete
                </button>
                <button
                  className="top-bar-menu-item"
                  onClick={() => void handleToggleProjector()}
                  type="button"
                  disabled={!currentImagePath}
                  aria-label={isProjectorOpen ? 'Close projector mode' : 'Open projector mode'}
                >
                  {isProjectorOpen ? 'Projector Off' : 'Projector'}
                </button>
                <button
                  className="top-bar-menu-item"
                  onClick={() => setShowSettings(true)}
                  type="button"
                >
                  Settings
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>
      {hasSelection && (
        <div
          className="contact-sheet-bulk-bar"
          role="toolbar"
          aria-label="Selected image actions"
          aria-busy={bulkCurationPending}
        >
          <span className="contact-sheet-bulk-count">{selectedPaths.length} selected</span>
          <button className="top-bar-menu-item" type="button" onClick={handleSelectAll}>
            Select All
          </button>
          <button className="top-bar-menu-item" type="button" onClick={handleClearSelection}>
            Clear
          </button>
          <span className="contact-sheet-bulk-divider" aria-hidden="true" />
          <button
            className="top-bar-menu-item"
            type="button"
            onClick={() => void handleBulkFavorite(true)}
            disabled={bulkCurationPending}
          >
            Favorite
          </button>
          <button
            className="top-bar-menu-item"
            type="button"
            onClick={() => void handleBulkFavorite(false)}
            disabled={bulkCurationPending}
          >
            Unfavorite
          </button>
          <div className="contact-sheet-bulk-rating" role="group" aria-label="Rate selected images">
            {[0, 1, 2, 3, 4, 5].map((rating) => (
              <button
                key={rating}
                className="top-bar-menu-item contact-sheet-rating-btn"
                type="button"
                onClick={() => void handleBulkRating(rating)}
                disabled={bulkCurationPending}
                aria-label={rating === 0 ? 'Clear selected ratings' : `Rate selected ${rating}`}
              >
                {rating}
              </button>
            ))}
          </div>
          <span className="contact-sheet-bulk-divider" aria-hidden="true" />
          {renderBulkQuickDestinationMenu('copy')}
          {renderBulkQuickDestinationMenu('move')}
          <button
            className="top-bar-menu-item"
            type="button"
            onClick={() => void handleDeleteSelected()}
          >
            Delete
          </button>
        </div>
      )}
      <div className="contact-sheet-content" ref={contentRef} onScroll={handleScroll}>
        {searchResults.length === 0 && normalizedQuery ? (
          <div className="contact-sheet-empty">No filenames match “{searchQuery.trim()}”.</div>
        ) : (
          <div
            className="contact-sheet-grid"
            ref={gridRef}
            role="grid"
            aria-label="Folder contact sheet"
            style={{
              gridTemplateColumns: `repeat(${columns}, ${GRID_ITEM_SIZE}px)`,
            }}
          >
            {visibleRange.topHeight > 0 && (
              <div className="grid-spacer" style={{ height: visibleRange.topHeight }} />
            )}
            {/* fallow-ignore-next-line complexity -- virtualized grid rendering boundary */}
            {visibleResults.map((result, visibleIndex) => {
              const resultIndex = visibleRange.startIndex + visibleIndex;
              const { image } = result;
              const isActive = image.path === currentImagePath && currentResultIndex >= 0;
              const url = getCachedThumbnail({
                path: image.path,
                sizeBytes: image.size_bytes,
                modifiedAt: image.modified_at,
              });
              const curation = curationByPath[image.path];
              const isFavorite = Boolean(curation?.favorite);
              const rating = curation?.rating ?? 0;

              return (
                <button
                  key={image.path}
                  className={`grid-item ${isActive ? 'active' : ''} ${selectedPathSet.has(image.path) ? 'selected' : ''}`}
                  onClick={(event) => handleGridItemClick(event, resultIndex, result)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.stopPropagation();
                      handleSelect(result);
                    } else if (event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedPaths((current) => toggleSelectionPath(current, image.path));
                      setLastSelectedIndex(resultIndex);
                    }
                  }}
                  data-image-path={image.path}
                  role="gridcell"
                  aria-label={image.file_name}
                  aria-selected={selectedPathSet.has(image.path)}
                  aria-current={isActive ? 'true' : undefined}
                  tabIndex={
                    image.path ===
                    (searchResults[currentResultIndex]?.image.path ?? displayedImages[0]?.path)
                      ? 0
                      : -1
                  }
                  type="button"
                  title={image.file_name}
                >
                  <div className="grid-thumbnail-wrapper">
                    {(isFavorite || rating > 0) && (
                      <div className="grid-curation-badges" aria-hidden="true">
                        {isFavorite && <span className="grid-curation-badge favorite">★</span>}
                        {rating > 0 && <span className="grid-curation-badge rating">{rating}</span>}
                      </div>
                    )}
                    {url ? (
                      <img src={url} alt="" draggable={false} />
                    ) : (
                      <div className="grid-placeholder" />
                    )}
                  </div>
                  <div className="grid-label" title={image.file_name}>
                    {image.file_name}
                  </div>
                </button>
              );
            })}
            {visibleRange.bottomHeight > 0 && (
              <div className="grid-spacer" style={{ height: visibleRange.bottomHeight }} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactNode,
} from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import { ExifPanel } from './ExifPanel';
import { ImageCaptionOverlay } from './ImageCaptionOverlay';
import {
  closeSecondaryWindow,
  type CropRect,
  getFileName,
  getImageCaption,
  type ImageCaption,
  openSecondaryWindow,
  overwriteWithCrop,
  saveCroppedCopy,
} from '../services/tauriCommands';
import { useViewerStore } from '../state/viewerStore';
import {
  chooseQuickDestinationFolder,
  canSaveRotationForPath,
  copyCurrentImage,
  copyCurrentImageFileName,
  copyCurrentImagePath,
  copyTextToClipboard,
  deleteImages,
  deleteCurrentImage,
  openCurrentImageInEditor,
  revealCurrentImage,
  showTransferResultMessage,
  transferImagesToDestination,
} from '../services/viewerActions';
import { getCropSourceDimensions } from '../services/cropSourceDimensions';
import { normalizedToIntegerPixelRect } from '../services/cropMath';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { useProjectorState } from '../hooks/useProjectorState';
import { useCurationStore } from '../state/curationStore';
import { useEditQueueStore } from '../state/editQueueStore';
import { useSettingsStore } from '../state/settingsStore';
import { useToastStore } from '../state/toastStore';
import { getCurationFilterLabel, type CurationFilter } from '../services/curationFilter';
import type { PinnableToolbarActionId, QuickDestination } from '../types/settings';
import { CurationFilterMenu } from './CurationFilterMenu';
import { EditQueuePanel } from './EditQueuePanel';
import { ToolbarIcon } from './ToolbarIcon';
import { FolderSortMenu } from './FolderSortMenu';
import { QualityExportMenu } from './QualityExportMenu';

interface ViewerChromeProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecentFolder: (folderPath: string, filter?: CurationFilter) => void | Promise<void>;
  onRefreshFolder: () => void;
  onGoHome: () => void;
  onFirst: () => void;
  onLast: () => void;
  onNext: () => void;
  onPrev: () => void;
  onStartSlideshow: () => void | Promise<void>;
  onStopSlideshow: () => void | Promise<void>;
  onTogglePause: () => void;
}

type SecondaryToolbarActionId =
  | 'captions'
  | 'copy'
  | 'copy-path'
  | 'copy-to'
  | 'crop'
  | 'delete'
  | 'edit'
  | 'info'
  | 'move-to'
  | 'projector'
  | 'refresh'
  | 'recent-folders'
  | 'reveal'
  | 'settings';

type ZoomControlActionId = 'zoom-out' | 'zoom-reset' | 'zoom-in';

const ZOOM_CONTROL_DUPLICATE_GUARD_MS = 250;
const COMPACT_BOTTOM_CONTROLS_QUERY = '(max-width: 1120px)';
const COMPACT_ROTATE_CONTROLS_QUERY = '(max-width: 820px)';
const RATING_VALUES = [0, 1, 2, 3, 4, 5] as const;

type SecondaryActionGroup = 'file' | 'organize' | 'workspace' | 'view';

interface PreparedCroppedCopy {
  outputPath: string;
  cropRect: CropRect;
}

interface ContextMenuState {
  x: number;
  y: number;
  open: boolean;
  path: string | null;
}

interface MenuShortcutAction {
  label: string;
  icon?: Parameters<typeof ToolbarIcon>[0]['name'];
  shortcut?: string;
}

interface SlideshowOptionsProps {
  menuRef: RefObject<HTMLDetailsElement | null>;
  canStart: boolean;
  shuffle: boolean;
  direction: 'forward' | 'reverse';
  repeat: boolean;
  interval: number;
  autoFullscreen: boolean;
  updateSettings: (partial: {
    shuffleSlideshow?: boolean;
    slideshowDirection?: 'forward' | 'reverse';
    loopSlideshow?: boolean;
    slideshowIntervalSeconds?: number;
    autoFullscreenOnSlideshow?: boolean;
  }) => Promise<boolean>;
}

function SlideshowOptions({
  menuRef,
  canStart,
  shuffle,
  direction,
  repeat,
  interval,
  autoFullscreen,
  updateSettings,
}: SlideshowOptionsProps) {
  const triggerRef = useRef<HTMLElement | null>(null);

  const closeAndRestoreFocus = () => {
    if (menuRef.current?.open) {
      menuRef.current.open = false;
      triggerRef.current?.focus();
    }
  };

  return (
    <details ref={menuRef} className="slideshow-options-menu">
      <summary
        ref={triggerRef}
        className="control-btn control-btn--text slideshow-options-trigger"
        aria-label="Slideshow options"
        aria-disabled={!canStart}
        onClick={(event) => {
          if (!canStart) event.preventDefault();
        }}
      >
        Slideshow options
      </summary>
      <div
        className="slideshow-options-panel"
        role="group"
        aria-label="Slideshow options"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeAndRestoreFocus();
          }
        }}
      >
        <label className="slideshow-options-field">
          <span>Order</span>
          <select
            aria-label="Slideshow order"
            value={shuffle ? 'shuffle' : 'sequential'}
            onChange={(event) =>
              void updateSettings({ shuffleSlideshow: event.target.value === 'shuffle' })
            }
          >
            <option value="sequential">Sequential</option>
            <option value="shuffle">Shuffle</option>
          </select>
        </label>
        <label className="slideshow-options-field">
          <span>Direction</span>
          <select
            aria-label="Slideshow direction"
            value={direction}
            onChange={(event) =>
              void updateSettings({
                slideshowDirection: event.target.value as 'forward' | 'reverse',
              })
            }
          >
            <option value="forward">Forward</option>
            <option value="reverse">Reverse</option>
          </select>
        </label>
        <label className="slideshow-options-field">
          <span>Repeat</span>
          <select
            aria-label="Slideshow repeat"
            value={repeat ? 'on' : 'off'}
            onChange={(event) =>
              void updateSettings({ loopSlideshow: event.target.value === 'on' })
            }
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>
        <label className="slideshow-options-field">
          <span>Interval (seconds)</span>
          <input
            aria-label="Slideshow interval in seconds"
            type="number"
            min={1}
            max={60}
            step={1}
            value={interval}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isInteger(next)) {
                void updateSettings({ slideshowIntervalSeconds: Math.min(60, Math.max(1, next)) });
              }
            }}
          />
        </label>
        <label className="slideshow-options-checkbox">
          <input
            aria-label="Enter fullscreen automatically"
            type="checkbox"
            checked={autoFullscreen}
            onChange={(event) =>
              void updateSettings({ autoFullscreenOnSlideshow: event.target.checked })
            }
          />
          <span>Enter fullscreen automatically</span>
        </label>
      </div>
    </details>
  );
}

function MenuLabel({ label, icon, shortcut }: MenuShortcutAction) {
  return (
    <span className="menu-shortcut-row">
      <span className="menu-shortcut-label">
        {icon ? (
          <span className="menu-shortcut-icon" aria-hidden="true">
            <ToolbarIcon name={icon} />
          </span>
        ) : null}
        <span>{label}</span>
      </span>
      {shortcut ? <span className="shortcut-key menu-shortcut-key">{shortcut}</span> : null}
    </span>
  );
}

function getMediaQueryMatch(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(query).matches;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => getMediaQueryMatch(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia(query);
    const update = () => setMatches(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);

    return () => mediaQuery.removeEventListener('change', update);
  }, [query]);

  return matches;
}

interface SecondaryActionDefinition {
  id: SecondaryToolbarActionId;
  label: string;
  icon: Parameters<typeof ToolbarIcon>[0]['name'];
  group: SecondaryActionGroup;
  menuNode: ReactNode;
  pinnedNode: ReactNode;
}

interface SecondaryActionGroupDefinition {
  id: SecondaryActionGroup;
  label: string;
}

const SECONDARY_ACTION_GROUPS: SecondaryActionGroupDefinition[] = [
  { id: 'file', label: 'File' },
  { id: 'organize', label: 'Organize' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'view', label: 'View' },
];

const PINNABLE_ACTION_IDS: readonly PinnableToolbarActionId[] = [
  'refresh',
  'recent-folders',
  'reveal',
  'copy',
  'copy-path',
  'copy-to',
  'move-to',
  'edit',
  'delete',
  'projector',
  'info',
  'settings',
] as const;

function isPinnableActionId(
  actionId: SecondaryToolbarActionId
): actionId is PinnableToolbarActionId {
  return (PINNABLE_ACTION_IDS as readonly string[]).includes(actionId);
}

function RatingControls({
  currentRating,
  onSetRating,
  className = '',
}: {
  currentRating: number;
  onSetRating: (rating: number) => void;
  className?: string;
}) {
  return (
    <div className={`rating-controls ${className}`.trim()} role="group" aria-label="Image rating">
      {RATING_VALUES.map((value) => (
        <button
          key={value}
          className={`control-btn rating-btn has-tooltip ${currentRating === value ? 'active' : ''}`}
          onClick={() => onSetRating(value)}
          data-tooltip={value === 0 ? 'Clear rating (Alt+0)' : `Set rating ${value} (Alt+${value})`}
          title={value === 0 ? 'Clear rating (Alt+0)' : `Set rating ${value} (Alt+${value})`}
          aria-label={value === 0 ? 'Clear rating' : `Set rating ${value}`}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/** Top bar and navigation overlay controls */
// fallow-ignore-next-line complexity
export function ViewerChrome({
  onOpenFile,
  onOpenFolder,
  onOpenRecentFolder,
  onRefreshFolder,
  onGoHome,
  onFirst,
  onLast,
  onNext,
  onPrev,
  onStartSlideshow,
  onStopSlideshow,
  onTogglePause,
}: ViewerChromeProps) {
  const currentImagePath = useViewerStore((state) => state.currentImagePath);
  const images = useViewerStore((state) => state.images);
  const currentIndex = useViewerStore((state) => state.currentIndex);
  const folderPath = useViewerStore((state) => state.folderPath);
  const isFullscreen = useViewerStore((state) => state.isFullscreen);
  const isSlideshowActive = useViewerStore((state) => state.isSlideshowActive);
  const isSlideshowPaused = useViewerStore((state) => state.isSlideshowPaused);
  const zoomMode = useViewerStore((state) => state.zoomMode);
  const zoomLevel = useViewerStore((state) => state.zoomLevel);
  const isFolderScanning = useViewerStore((state) => state.isFolderScanning);
  const curationFilter = useViewerStore((state) => state.curationFilter);
  const markedPaths = useViewerStore((state) => state.markedPaths);
  const setFullscreen = useViewerStore((state) => state.setFullscreen);
  const setShowSettings = useViewerStore((state) => state.setShowSettings);
  const setZoomMode = useViewerStore((state) => state.setZoomMode);
  const resetZoom = useViewerStore((state) => state.resetZoom);
  const setCurationFilter = useViewerStore((state) => state.setCurationFilter);
  const zoomIn = useViewerStore((state) => state.zoomIn);
  const zoomOut = useViewerStore((state) => state.zoomOut);
  const removeImage = useViewerStore((state) => state.removeImage);
  const rotation = useViewerStore((state) => state.rotation);
  const isCropMode = useViewerStore((state) => state.isCropMode);
  const cropRect = useViewerStore((state) => state.cropRect);
  const pendingCropPreview = useViewerStore((state) => state.pendingCropPreview);
  const pendingEditsByPath = useViewerStore((state) => state.pendingEditsByPath);
  const cropAspectRatio = useViewerStore((state) => state.cropAspectRatio);
  const viewMode = useViewerStore((state) => state.viewMode);
  const setViewMode = useViewerStore((state) => state.setViewMode);
  const enterCompareMode = useViewerStore((state) => state.enterCompareMode);
  const exitCompareMode = useViewerStore((state) => state.exitCompareMode);
  const enterCropMode = useViewerStore((state) => state.enterCropMode);
  const exitCropMode = useViewerStore((state) => state.exitCropMode);
  const isCompareZoomLocked = useViewerStore((state) => state.isCompareZoomLocked);
  const setCropAspectRatio = useViewerStore((state) => state.setCropAspectRatio);
  const resetCrop = useViewerStore((state) => state.resetCrop);
  const applyCropPreview = useViewerStore((state) => state.applyCropPreview);
  const clearCropPreview = useViewerStore((state) => state.clearCropPreview);
  const clearPendingEdits = useViewerStore((state) => state.clearPendingEdits);
  const commitPendingEdits = useViewerStore((state) => state.commitPendingEdits);
  const toggleMarkedPath = useViewerStore((state) => state.toggleMarkedPath);
  const clearMarkedPaths = useViewerStore((state) => state.clearMarkedPaths);
  const markAllVisibleImages = useViewerStore((state) => state.markAllVisibleImages);
  const setCurrentIndex = useViewerStore((state) => state.setCurrentIndex);
  const setMarkedPaths = useViewerStore((state) => state.setMarkedPaths);
  const setCompareZoomLocked = useViewerStore((state) => state.setCompareZoomLocked);
  const removeImagesByPaths = useViewerStore((state) => state.removeImagesByPaths);
  const curationByPath = useCurationStore((state) => state.curationByPath);
  const toggleFavorite = useCurationStore((state) => state.toggleFavorite);
  const setRating = useCurationStore((state) => state.setRating);
  const enqueueEditJob = useEditQueueStore((state) => state.enqueueJob);
  const editQueueActiveCount = useEditQueueStore((state) => state.summary.activeCount);
  const editQueueFailedCount = useEditQueueStore((state) => state.summary.failedCount);
  const editQueueIsRunning = useEditQueueStore((state) => state.isRunning);
  const quickDestinations = useSettingsStore((state) => state.settings.quickDestinations);
  const recentFolders = useSettingsStore((state) => state.settings.recentFolders);
  const savedViewPresets = useSettingsStore((state) => state.settings.savedViewPresets);
  const externalEditorPath = useSettingsStore((state) => state.settings.externalEditorPath);
  const externalEditorLabel = useSettingsStore((state) => state.settings.externalEditorLabel);
  const cropSaveMode = useSettingsStore((state) => state.settings.cropSaveMode);
  const pinnedToolbarActions = useSettingsStore((state) => state.settings.pinnedToolbarActions);
  const showThumbnails = useSettingsStore((state) => state.settings.showThumbnails);
  const showImageCaptions = useSettingsStore((state) => state.settings.showImageCaptions);
  const shuffleSlideshow = useSettingsStore((state) => state.settings.shuffleSlideshow);
  const slideshowDirection = useSettingsStore((state) => state.settings.slideshowDirection);
  const loopSlideshow = useSettingsStore((state) => state.settings.loopSlideshow);
  const slideshowIntervalSeconds = useSettingsStore(
    (state) => state.settings.slideshowIntervalSeconds
  );
  const autoFullscreenOnSlideshow = useSettingsStore(
    (state) => state.settings.autoFullscreenOnSlideshow
  );
  const promptProjectorGridOnOpen = useSettingsStore(
    (state) => state.settings.promptProjectorGridOnOpen
  );
  const openProjectorInGridView = useSettingsStore(
    (state) => state.settings.openProjectorInGridView
  );
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const pushToast = useToastStore((state) => state.pushToast);

  const [showExif, setShowExif] = useState(false);
  const [exifRefreshToken, setExifRefreshToken] = useState(0);
  const [captionRefreshToken, setCaptionRefreshToken] = useState(0);
  const [imageCaption, setImageCaption] = useState<ImageCaption | null>(null);
  const [showProjectorGridPrompt, setShowProjectorGridPrompt] = useState(false);
  const [skipProjectorGridPrompt, setSkipProjectorGridPrompt] = useState(false);
  const [isMarkedActionsMenuOpen, setIsMarkedActionsMenuOpen] = useState(false);
  const [isEditQueuePanelOpen, setIsEditQueuePanelOpen] = useState(false);
  const [isCustomizingToolbar, setIsCustomizingToolbar] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    x: 0,
    y: 0,
    open: false,
    path: null,
  });
  const { isProjectorOpen, refreshProjectorState } = useProjectorState();
  const chromeRootRef = useRef<HTMLDivElement | null>(null);
  const markedActionsMenuRef = useRef<HTMLDetailsElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDetailsElement | null>(null);
  const qualityMenuRef = useRef<HTMLDetailsElement | null>(null);
  const editQueueMenuRef = useRef<HTMLDetailsElement | null>(null);
  const cropActionsMenuRef = useRef<HTMLDetailsElement | null>(null);
  const compactBottomMenuRef = useRef<HTMLDetailsElement | null>(null);
  const slideshowOptionsMenuRef = useRef<HTMLDetailsElement | null>(null);
  const shouldUseCompactBottomControls = useMediaQuery(COMPACT_BOTTOM_CONTROLS_QUERY);
  const shouldMoveRotateControls = useMediaQuery(COMPACT_ROTATE_CONTROLS_QUERY);

  useEffect(() => {
    const handler = () => setShowExif((value) => !value);
    window.addEventListener('toggle-exif', handler);

    return () => {
      window.removeEventListener('toggle-exif', handler);
    };
  }, []);

  useEffect(() => {
    let isCurrent = true;
    setImageCaption(null);

    if (!currentImagePath) {
      return () => {
        isCurrent = false;
      };
    }

    void getImageCaption(currentImagePath)
      .then((caption) => {
        if (isCurrent) setImageCaption(caption);
      })
      .catch((error) => {
        if (isCurrent) {
          console.error('Failed to read image caption:', error);
          setImageCaption(null);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [captionRefreshToken, currentImagePath]);

  const menuRefs = useMemo(
    () => [
      markedActionsMenuRef,
      contextMenuRef,
      moreMenuRef,
      qualityMenuRef,
      editQueueMenuRef,
      cropActionsMenuRef,
      compactBottomMenuRef,
      slideshowOptionsMenuRef,
    ],
    []
  );

  const closeOverflowMenus = useCallback(() => {
    const menuNodes = [chromeRootRef.current, ...menuRefs.map((ref) => ref.current)];

    for (const node of menuNodes) {
      if (!node) {
        continue;
      }

      if (node instanceof HTMLDetailsElement) {
        node.open = false;
      }

      node.querySelectorAll('details[open]').forEach((menu) => {
        (menu as HTMLDetailsElement).open = false;
      });
    }
  }, [menuRefs]);

  const closeContextMenu = useCallback(() => {
    setContextMenu((current) => (current.open ? { ...current, open: false, path: null } : current));
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (
        target.closest(
          '.top-bar-menu, .top-bar-submenu, .quality-menu, .crop-actions-menu, .bottom-controls-menu, .edit-queue-menu, .slideshow-options-menu, .context-menu'
        )
      ) {
        return;
      }

      closeOverflowMenus();
      closeContextMenu();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeOverflowMenus();
        closeContextMenu();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closeContextMenu, closeOverflowMenus, menuRefs]);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      if (!currentImagePath || viewMode !== 'viewer') {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        !target ||
        target.closest('input, textarea, select, button, summary, .settings-panel, .context-menu')
      ) {
        return;
      }

      if (
        !target.closest(
          '.image-canvas, .top-bar, .bottom-controls, .thumbnail-strip, .nav-arrow, .slideshow-indicator'
        )
      ) {
        return;
      }

      event.preventDefault();
      closeOverflowMenus();
      const menuWidth = 240;
      const menuHeight = 260;
      const thumbnailPath = target.closest('.thumbnail-item')?.getAttribute('data-image-path');
      setContextMenu({
        x: Math.min(event.clientX, window.innerWidth - menuWidth - 12),
        y: Math.min(event.clientY, window.innerHeight - menuHeight - 12),
        open: true,
        path: thumbnailPath || currentImagePath,
      });
    };

    const handleScroll = () => closeContextMenu();

    document.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [closeContextMenu, closeOverflowMenus, currentImagePath, viewMode]);

  const togglePinnedAction = async (actionId: PinnableToolbarActionId) => {
    const nextPinnedActions = pinnedToolbarActions.includes(actionId)
      ? pinnedToolbarActions.filter((value) => value !== actionId)
      : [...pinnedToolbarActions, actionId];

    await updateSettings({ pinnedToolbarActions: nextPinnedActions });
  };

  const persistProjectorPromptPreference = async (nextOpenProjectorInGridView: boolean) => {
    await updateSettings({
      openProjectorInGridView: nextOpenProjectorInGridView,
      ...(skipProjectorGridPrompt ? { promptProjectorGridOnOpen: false } : {}),
    });
  };

  const fileName = currentImagePath
    ? currentImagePath.replace(/\\/g, '/').split('/').pop() || ''
    : '';
  const canSaveRotation = canSaveRotationForPath(currentImagePath);
  const canEnterCompareMode = images.length > 1;
  const cropDisabledByRotation = rotation !== 0 || viewMode === 'compare';
  const canPreviewCrop = isCropMode && cropRect !== null;
  const canStartSlideshow = images.length > 1;
  const currentPendingEdit = currentImagePath ? pendingEditsByPath[currentImagePath] : undefined;
  const hasPendingEdits = Boolean(currentPendingEdit);
  const canCommitPendingEdits =
    Boolean(currentPendingEdit?.cropRect) || (hasPendingEdits && canSaveRotation);
  const currentCuration = currentImagePath ? curationByPath[currentImagePath] : undefined;
  const isFavorite = Boolean(currentCuration?.favorite);
  const currentRating = currentCuration?.rating ?? 0;
  const slideshowToggleLabel = isSlideshowPaused ? 'Resume slideshow' : 'Pause slideshow';
  const slideshowShuffleLabel = shuffleSlideshow
    ? 'Turn slideshow shuffle off'
    : 'Shuffle slideshow';
  const markedPathSet = useMemo(() => new Set(markedPaths), [markedPaths]);
  const isCurrentMarked = currentImagePath ? markedPathSet.has(currentImagePath) : false;
  const contextMenuPath = contextMenu.path;
  const isContextMenuPathMarked = contextMenuPath ? markedPathSet.has(contextMenuPath) : false;

  const jumpToLastMarked = () => {
    const lastMarkedPath = markedPaths[markedPaths.length - 1];
    if (!lastMarkedPath) return;

    const normalizedLastMarkedPath = lastMarkedPath.replace(/\\/g, '/').toLowerCase();
    const lastMarkedIndex = images.findIndex(
      (image) => image.path.replace(/\\/g, '/').toLowerCase() === normalizedLastMarkedPath
    );
    if (lastMarkedIndex >= 0) {
      setCurrentIndex(lastMarkedIndex);
      setIsMarkedActionsMenuOpen(false);
      closeOverflowMenus();
    }
  };
  const toggleFullscreen = async () => {
    try {
      const appWindow = getCurrentWindow();
      const nextFullscreen = !isFullscreen;
      await appWindow.setFullscreen(nextFullscreen);
      setFullscreen(nextFullscreen);
    } catch (err) {
      console.error('Failed to toggle fullscreen:', err);
    }
  };

  const handleToggleSlideshowShuffle = () => {
    void updateSettings({
      shuffleSlideshow: !shuffleSlideshow,
    });
  };

  const handleDelete = async () => {
    await deleteCurrentImage({ currentImagePath, currentIndex, removeImage });
    closeOverflowMenus();
    closeContextMenu();
  };

  const handleContextMenuDelete = async () => {
    if (!contextMenuPath) {
      return;
    }

    await deleteImages({
      imagePaths: [contextMenuPath],
      removeImagesByPaths,
    });
    closeContextMenu();
    closeOverflowMenus();
  };

  const handleCopy = async () => {
    await copyCurrentImage(currentImagePath);
    closeOverflowMenus();
    closeContextMenu();
  };

  const handleCopyPath = async () => {
    await copyCurrentImagePath(currentImagePath);
    closeOverflowMenus();
    closeContextMenu();
  };

  const handleOpenInEditor = async () => {
    await openCurrentImageInEditor(currentImagePath, externalEditorPath, externalEditorLabel);
    closeOverflowMenus();
    closeContextMenu();
  };

  const handleReveal = async () => {
    await revealCurrentImage(currentImagePath);
    closeOverflowMenus();
    closeContextMenu();
  };

  const handleRefresh = () => {
    onRefreshFolder();
    setCaptionRefreshToken((value) => value + 1);
    closeOverflowMenus();
  };

  const handleToggleCaptions = () => {
    closeOverflowMenus();
    void updateSettings({ showImageCaptions: !showImageCaptions });
  };

  const handleCopyCaption = async () => {
    if (!imageCaption) return;

    try {
      await copyTextToClipboard(imageCaption.text);
      pushToast({
        title: 'Caption copied',
        kind: 'success',
        message: 'Image caption copied to clipboard.',
      });
    } catch (error) {
      pushToast({
        title: 'Caption copy failed',
        kind: 'error',
        message: `Failed to copy image caption: ${error}`,
      });
    }
  };

  const handleOpenRecentFolder = async (folderPath: string, filter?: CurationFilter) => {
    await onOpenRecentFolder(folderPath, filter);
    closeOverflowMenus();
  };

  const handleQuickTransfer = async (destination: QuickDestination, mode: 'copy' | 'move') => {
    if (!currentImagePath) {
      return;
    }

    const result = await transferImagesToDestination([currentImagePath], destination, mode);
    if (mode === 'move') {
      useViewerStore
        .getState()
        .removeImagesByPaths(result.successes.map((success) => success.sourcePath));
    }
    showTransferResultMessage(result, destination, mode);
    closeOverflowMenus();
  };

  const handleChooseTransferFolder = async (mode: 'copy' | 'move') => {
    const destination = await chooseQuickDestinationFolder();
    if (!destination) {
      return;
    }

    await handleQuickTransfer(destination, mode);
  };

  const handleToggleFavorite = async () => {
    if (!currentImagePath) {
      return;
    }
    await toggleFavorite(currentImagePath);
  };

  const handleSetRating = async (rating: number) => {
    if (!currentImagePath) {
      return;
    }
    await setRating(currentImagePath, rating);
  };

  const handleToggleInfo = () => {
    setShowExif((value) => !value);
    closeOverflowMenus();
  };

  const handleOpenSettings = () => {
    setShowSettings(true);
    closeOverflowMenus();
  };

  const handleProjectorPromptKeepCurrentView = async () => {
    await persistProjectorPromptPreference(false);
    setShowProjectorGridPrompt(false);
    setSkipProjectorGridPrompt(false);
  };

  const handleProjectorPromptSwitchToGrid = async () => {
    await persistProjectorPromptPreference(true);
    setViewMode('grid');
    setShowProjectorGridPrompt(false);
    setSkipProjectorGridPrompt(false);
  };

  const handleToggleProjector = async () => {
    try {
      if (isProjectorOpen) {
        await closeSecondaryWindow();
        setShowProjectorGridPrompt(false);
        setSkipProjectorGridPrompt(false);
      } else {
        const shouldOpenInGridView = openProjectorInGridView && viewMode !== 'grid';
        await openSecondaryWindow();
        if (shouldOpenInGridView) {
          setViewMode('grid');
        }
        if (promptProjectorGridOnOpen && !openProjectorInGridView && viewMode !== 'grid') {
          setSkipProjectorGridPrompt(false);
          setShowProjectorGridPrompt(true);
        }
      }
      await refreshProjectorState();
      closeOverflowMenus();
    } catch (err) {
      console.error('Failed to toggle projector mode:', err);
      pushToast({
        title: 'Projector mode',
        kind: 'error',
        message: isProjectorOpen
          ? 'Unable to close projector mode right now.'
          : 'Unable to open projector mode. Please try again after reconnecting the display.',
      });
    }
  };

  const handleToggleCrop = () => {
    if (isCropMode) {
      exitCropMode();
      closeOverflowMenus();
      return;
    }

    if (pendingCropPreview) {
      clearCropPreview();
    }
    enterCropMode();
    closeOverflowMenus();
  };

  const prepareCroppedCopy = async (): Promise<PreparedCroppedCopy | null> => {
    if (!currentImagePath || !cropRect) {
      return null;
    }

    const dimensions = await getCropSourceDimensions(currentImagePath);
    if (!dimensions) {
      pushToast({
        title: 'Crop Copy',
        kind: 'error',
        message: 'Unable to determine image dimensions for crop export.',
      });
      return null;
    }

    const { width: imageWidth, height: imageHeight } = dimensions;
    const pixelCropRect = normalizedToIntegerPixelRect(cropRect, imageWidth, imageHeight);
    const originalName = getFileName(currentImagePath);
    const dotIndex = originalName.lastIndexOf('.');
    const baseName = dotIndex >= 0 ? originalName.slice(0, dotIndex) : originalName;
    const extension = dotIndex >= 0 ? originalName.slice(dotIndex) : '';
    const outputPath = await save({
      defaultPath: currentImagePath.replace(originalName, `${baseName}-cropped${extension}`),
    });

    if (!outputPath) {
      return null;
    }

    return { outputPath, cropRect: pixelCropRect };
  };

  const handleQueueCroppedCopy = async () => {
    const preparedCopy = await prepareCroppedCopy();
    if (!preparedCopy || !currentImagePath) {
      return;
    }

    const result = enqueueEditJob({
      kind: 'cropped-copy',
      sourcePath: currentImagePath,
      outputPath: preparedCopy.outputPath,
      cropRect: preparedCopy.cropRect,
      rotationDegrees: rotation,
    });
    if (!result.ok) {
      pushToast({
        title: 'Editing Queue',
        kind: 'error',
        message: result.error,
      });
      return;
    }

    setIsEditQueuePanelOpen(true);
  };

  const handleSaveCroppedCopy = async (options?: { clearPendingEditsOnSuccess?: boolean }) => {
    const preparedCopy = await prepareCroppedCopy();
    if (!preparedCopy || !currentImagePath) {
      return;
    }

    try {
      await saveCroppedCopy(
        currentImagePath,
        preparedCopy.cropRect,
        preparedCopy.outputPath,
        rotation
      );
      if (options?.clearPendingEditsOnSuccess) {
        clearPendingEdits(currentImagePath);
      }
      pushToast({
        title: 'Cropped Copy Saved',
        kind: 'success',
        message: `Saved cropped copy to ${preparedCopy.outputPath}`,
      });
    } catch (err) {
      console.error('Failed to save cropped copy:', err);
      pushToast({
        title: 'Cropped Copy Failed',
        kind: 'error',
        message: `Failed to save cropped copy: ${err}`,
      });
    }
  };

  const handleOverwriteCrop = async () => {
    if (!currentImagePath || !cropRect) {
      return;
    }

    const dimensions = await getCropSourceDimensions(currentImagePath);
    if (!dimensions) {
      pushToast({
        title: 'Crop Overwrite',
        kind: 'error',
        message: 'Unable to determine image dimensions for crop overwrite.',
      });
      return;
    }

    const { width: imageWidth, height: imageHeight } = dimensions;

    const confirmed = await confirm(
      `Overwrite the original image with this crop?\n\n${fileName}\n\nThis modifies the source file.`,
      {
        title: 'Overwrite Cropped Image',
        kind: 'warning',
      }
    );

    if (!confirmed) {
      return;
    }

    try {
      await overwriteWithCrop(
        currentImagePath,
        normalizedToIntegerPixelRect(cropRect, imageWidth, imageHeight),
        rotation
      );
      invalidateImageAsset(currentImagePath);
      invalidateThumbnail(currentImagePath);
      clearPendingEdits(currentImagePath);
      useViewerStore.setState({ cacheBuster: Date.now() });
      setExifRefreshToken((value) => value + 1);
      pushToast({
        title: 'Crop Saved',
        kind: 'success',
        message: 'Original image updated with the cropped selection.',
      });
    } catch (err) {
      console.error('Failed to overwrite cropped image:', err);
      pushToast({
        title: 'Crop Overwrite Failed',
        kind: 'error',
        message: `Failed to overwrite cropped image: ${err}`,
      });
    }
  };

  const handleDeleteMarked = async () => {
    if (markedPaths.length === 0) {
      return;
    }

    await deleteImages({
      imagePaths: markedPaths,
      removeImagesByPaths,
    });
    closeContextMenu();
    closeOverflowMenus();
  };

  const handleBulkTransfer = async (destination: QuickDestination, mode: 'copy' | 'move') => {
    if (markedPaths.length === 0) {
      return;
    }

    const result = await transferImagesToDestination(markedPaths, destination, mode);
    const successfulPaths = new Set(result.successes.map((success) => success.sourcePath));
    const failedPaths = markedPaths.filter((path) => !successfulPaths.has(path));

    if (mode === 'move') {
      if (successfulPaths.size > 0) {
        removeImagesByPaths([...successfulPaths]);
      }
    }

    setMarkedPaths(failedPaths);
    showTransferResultMessage(result, destination, mode);
    closeContextMenu();
    closeOverflowMenus();
  };

  const handleChooseBulkTransferFolder = async (mode: 'copy' | 'move') => {
    const destination = await chooseQuickDestinationFolder();
    if (!destination) {
      return;
    }

    await handleBulkTransfer(destination, mode);
  };

  const handleSaveCurrentEdits = async () => {
    if (currentImagePath && currentPendingEdit?.cropRect && cropSaveMode === 'copy') {
      await handleSaveCroppedCopy({ clearPendingEditsOnSuccess: true });
      return;
    }

    if (currentImagePath) {
      await commitPendingEdits(currentImagePath);
    }
  };

  const getZoomDisplay = () => {
    if (zoomMode === 'fit') return 'Fit';
    if (zoomMode === 'fill') return 'Fill';
    if (zoomMode === 'actual') return '100%';
    return `${Math.round(zoomLevel * 100)}%`;
  };

  const zoomPointerActivationRef = useRef<ZoomControlActionId | null>(null);

  const stopZoomControlPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    zoomPointerActivationRef.current = null;
    event.stopPropagation();
  }, []);

  const activateZoomControl = useCallback((actionId: ZoomControlActionId, action: () => void) => {
    if (zoomPointerActivationRef.current === actionId) {
      return;
    }

    zoomPointerActivationRef.current = actionId;
    action();

    window.setTimeout(() => {
      if (zoomPointerActivationRef.current === actionId) {
        zoomPointerActivationRef.current = null;
      }
    }, ZOOM_CONTROL_DUPLICATE_GUARD_MS);
  }, []);

  const activateZoomControlOnPointerUp = useCallback(
    (actionId: ZoomControlActionId, action: () => void) =>
      (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (!event.pointerType) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        activateZoomControl(actionId, action);
      },
    [activateZoomControl]
  );

  const activateZoomControlOnMouseUp = useCallback(
    (actionId: ZoomControlActionId, action: () => void) =>
      (event: ReactMouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        activateZoomControl(actionId, action);
      },
    [activateZoomControl]
  );

  const activateZoomControlOnClick = useCallback(
    (actionId: ZoomControlActionId, action: () => void) =>
      (event: ReactMouseEvent<HTMLButtonElement>) => {
        if (zoomPointerActivationRef.current === actionId) {
          zoomPointerActivationRef.current = null;
          return;
        }

        event.stopPropagation();
        action();
      },
    []
  );

  if (!currentImagePath) return null;

  const renderPinnedButton = (
    actionId: SecondaryToolbarActionId,
    label: string,
    icon: Parameters<typeof ToolbarIcon>[0]['name'],
    onClick: () => void | Promise<void>,
    options?: {
      ariaLabel?: string;
      disabled?: boolean;
      active?: boolean;
      title?: string;
    }
  ) => (
    <button
      className={`top-bar-btn top-bar-btn--labeled has-tooltip ${options?.active ? 'active' : ''}`.trim()}
      onClick={() => void onClick()}
      data-tooltip={options?.title ?? label}
      title={options?.title ?? label}
      aria-label={options?.ariaLabel ?? label}
      id={`btn-pinned-${actionId}`}
      disabled={options?.disabled}
      type="button"
    >
      <span className="top-bar-btn-icon">
        <ToolbarIcon name={icon} />
      </span>
      <span className="top-bar-btn-label">{label}</span>
    </button>
  );

  const renderTransferSubmenu = (mode: 'copy' | 'move', summaryClassName: string) => (
    <details className="top-bar-submenu">
      <summary
        className={summaryClassName}
        aria-label={mode === 'copy' ? 'Copy image to destination' : 'Move image to destination'}
      >
        {summaryClassName.includes('top-bar-btn') ? (
          <>
            <span className="top-bar-btn-icon">
              <ToolbarIcon name={mode === 'copy' ? 'copy' : 'move'} />
            </span>
            <span className="top-bar-btn-label">{mode === 'copy' ? 'Copy To' : 'Move To'}</span>
          </>
        ) : (
          `${mode === 'copy' ? 'Copy To' : 'Move To'}`
        )}
      </summary>
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
              onClick={() => void handleQuickTransfer(destination, mode)}
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
        <button className="top-bar-menu-item" onClick={handleOpenSettings} type="button">
          Manage Saved Folders
        </button>
      </div>
    </details>
  );

  const renderRecentFoldersSubmenu = (summaryClassName: string) => (
    <details className="top-bar-submenu">
      <summary className={summaryClassName} aria-label="Open recent folder">
        {summaryClassName.includes('top-bar-btn') ? (
          <>
            <span className="top-bar-btn-icon">
              <ToolbarIcon name="folder" />
            </span>
            <span className="top-bar-btn-label">Recents</span>
          </>
        ) : (
          'Recent Folders'
        )}
      </summary>
      <div className="top-bar-submenu-panel">
        {recentFolders.length === 0 ? (
          <span className="top-bar-menu-empty">No recent folders yet.</span>
        ) : (
          recentFolders.map((folder) => (
            <div key={folder.path} className="top-bar-menu-entry">
              <button
                className="top-bar-menu-item top-bar-menu-item--truncate"
                onClick={() => void handleOpenRecentFolder(folder.path)}
                title={folder.path}
                type="button"
              >
                {folder.label}
              </button>
              {savedViewPresets.length > 0 && (
                <div className="top-bar-preset-row">
                  {savedViewPresets.map((preset) => (
                    <button
                      key={`${folder.path}:${preset}`}
                      className="top-bar-preset-chip"
                      onClick={() => void handleOpenRecentFolder(folder.path, preset)}
                      type="button"
                    >
                      {getCurationFilterLabel(preset)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </details>
  );

  const renderMarkedTransferSubmenu = (mode: 'copy' | 'move') => (
    <details className="top-bar-submenu">
      <summary
        className="top-bar-menu-item"
        aria-label={mode === 'copy' ? 'Copy marked images' : 'Move marked images'}
      >
        {mode === 'copy' ? 'Copy To' : 'Move To'}
      </summary>
      <div className="top-bar-submenu-panel">
        {quickDestinations.length === 0 ? (
          <span className="top-bar-menu-empty">
            No destinations configured yet. Use Choose Folder or add saved folders in Settings.
          </span>
        ) : (
          quickDestinations.map((destination) => (
            <button
              key={`${mode}:${destination.id}`}
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
          onClick={() => void handleChooseBulkTransferFolder(mode)}
          type="button"
        >
          Choose Folder...
        </button>
      </div>
    </details>
  );

  const secondaryActionDefinitions: SecondaryActionDefinition[] = [
    {
      id: 'refresh',
      label: 'Refresh',
      icon: 'refresh',
      group: 'file',
      menuNode: (
        <button
          className="top-bar-menu-item"
          onClick={handleRefresh}
          type="button"
          aria-label="Refresh folder"
          disabled={!folderPath}
        >
          <MenuLabel label="Refresh" shortcut="Ctrl+R / F6" />
        </button>
      ),
      pinnedNode: renderPinnedButton('refresh', 'Refresh', 'refresh', handleRefresh, {
        ariaLabel: 'Refresh folder',
        disabled: !folderPath,
      }),
    },
    {
      id: 'recent-folders',
      label: 'Recent Folders',
      icon: 'folder',
      group: 'file',
      menuNode: renderRecentFoldersSubmenu('top-bar-menu-item'),
      pinnedNode: renderRecentFoldersSubmenu('top-bar-btn top-bar-btn--labeled has-tooltip'),
    },
    {
      id: 'reveal',
      label: 'Reveal',
      icon: 'reveal',
      group: 'file',
      menuNode: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleReveal()}
          type="button"
          aria-label="Show in folder"
        >
          <MenuLabel label="Reveal" shortcut="Ctrl+Shift+O" />
        </button>
      ),
      pinnedNode: renderPinnedButton('reveal', 'Reveal', 'reveal', handleReveal, {
        ariaLabel: 'Show in folder',
      }),
    },
    {
      id: 'copy',
      label: 'Copy Image',
      icon: 'copy',
      group: 'organize',
      menuNode: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleCopy()}
          type="button"
          aria-label="Copy image to clipboard"
        >
          <MenuLabel label="Copy Image" />
        </button>
      ),
      pinnedNode: renderPinnedButton('copy', 'Copy', 'copy', handleCopy, {
        ariaLabel: 'Copy image to clipboard',
      }),
    },
    {
      id: 'copy-path',
      label: 'Copy Path',
      icon: 'copy',
      group: 'organize',
      menuNode: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleCopyPath()}
          type="button"
          aria-label="Copy image path"
        >
          <MenuLabel label="Copy Path" shortcut="Ctrl+Shift+C" />
        </button>
      ),
      pinnedNode: renderPinnedButton('copy-path', 'Path', 'copy', handleCopyPath, {
        ariaLabel: 'Copy image path',
      }),
    },
    {
      id: 'copy-to',
      label: 'Copy To',
      icon: 'copy',
      group: 'organize',
      menuNode: renderTransferSubmenu('copy', 'top-bar-menu-item'),
      pinnedNode: renderTransferSubmenu('copy', 'top-bar-btn top-bar-btn--labeled has-tooltip'),
    },
    {
      id: 'move-to',
      label: 'Move To',
      icon: 'move',
      group: 'organize',
      menuNode: renderTransferSubmenu('move', 'top-bar-menu-item'),
      pinnedNode: renderTransferSubmenu('move', 'top-bar-btn top-bar-btn--labeled has-tooltip'),
    },
    {
      id: 'edit',
      label: externalEditorLabel ? `Edit in ${externalEditorLabel}` : 'Edit',
      icon: 'edit',
      group: 'organize',
      menuNode: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleOpenInEditor()}
          type="button"
          aria-label="Open in external editor"
        >
          <MenuLabel
            label={externalEditorLabel ? `Edit in ${externalEditorLabel}` : 'Edit'}
            shortcut="Ctrl+E"
          />
        </button>
      ),
      pinnedNode: renderPinnedButton('edit', 'Edit', 'edit', handleOpenInEditor, {
        ariaLabel: 'Open in external editor',
      }),
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'delete',
      group: 'organize',
      menuNode: (
        <button
          className="top-bar-menu-item top-bar-menu-item--danger"
          onClick={() => void handleDelete()}
          type="button"
          aria-label="Delete image"
        >
          <MenuLabel label="Delete" shortcut="Delete" />
        </button>
      ),
      pinnedNode: renderPinnedButton('delete', 'Delete', 'delete', handleDelete, {
        ariaLabel: 'Delete image',
      }),
    },
    {
      id: 'projector',
      label: isProjectorOpen ? 'Projector Off' : 'Projector',
      icon: 'projector',
      group: 'workspace',
      menuNode: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleToggleProjector()}
          type="button"
          aria-label={isProjectorOpen ? 'Close projector mode' : 'Open projector mode'}
        >
          <MenuLabel label={isProjectorOpen ? 'Projector Off' : 'Projector'} />
        </button>
      ),
      pinnedNode: renderPinnedButton(
        'projector',
        isProjectorOpen ? 'Projector Off' : 'Projector',
        'projector',
        handleToggleProjector,
        {
          ariaLabel: isProjectorOpen ? 'Close projector mode' : 'Open projector mode',
          active: isProjectorOpen,
        }
      ),
    },
    {
      id: 'captions',
      label: 'Show Captions',
      icon: 'caption',
      group: 'view',
      menuNode: (
        <button
          className="top-bar-menu-item top-bar-menu-item--checkable"
          onClick={handleToggleCaptions}
          type="button"
          aria-label="Show image captions"
          aria-pressed={showImageCaptions}
        >
          <MenuLabel label="Show Captions" />
        </button>
      ),
      pinnedNode: null,
    },
    {
      id: 'info',
      label: showExif ? 'Hide Info' : 'Info',
      icon: 'info',
      group: 'view',
      menuNode: (
        <button
          className="top-bar-menu-item"
          onClick={handleToggleInfo}
          type="button"
          aria-label="Toggle image info panel"
        >
          <MenuLabel label={showExif ? 'Hide Info' : 'Info'} shortcut="I" />
        </button>
      ),
      pinnedNode: renderPinnedButton('info', 'Info', 'info', handleToggleInfo, {
        ariaLabel: 'Toggle image info panel',
        active: showExif,
      }),
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: 'settings',
      group: 'view',
      menuNode: (
        <button
          className="top-bar-menu-item"
          onClick={handleOpenSettings}
          type="button"
          aria-label="Open settings"
        >
          <MenuLabel label="Settings" shortcut="Ctrl+," />
        </button>
      ),
      pinnedNode: renderPinnedButton('settings', 'Settings', 'settings', handleOpenSettings, {
        ariaLabel: 'Open settings',
      }),
    },
  ];

  const secondaryActionsById = new Map(
    secondaryActionDefinitions.map((action) => [action.id, action] as const)
  );
  const pinnedSecondaryActions = pinnedToolbarActions
    .map((actionId) => secondaryActionsById.get(actionId))
    .filter((action): action is SecondaryActionDefinition => Boolean(action));

  return (
    <>
      <div className="top-bar" role="toolbar" aria-label="Image information" ref={chromeRootRef}>
        <div className="top-bar-left">
          <span className="file-name" title={fileName}>
            {fileName}
          </span>
          {images.length > 0 && (
            <span className="image-counter">
              {currentIndex + 1} / {images.length}
              {isFolderScanning && ' …'}
            </span>
          )}
          {isFavorite && <span className="image-counter">★</span>}
          {currentRating > 0 && <span className="image-counter">{currentRating}/5</span>}
          {hasPendingEdits && <span className="image-counter">Unsaved edits</span>}
        </div>

        <div className="top-bar-right">
          <div className="top-bar-group" aria-label="Navigation actions">
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={onGoHome}
              data-tooltip="Return to start screen"
              title="Return to start screen"
              aria-label="Return to start screen"
              id="btn-home"
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
              id="btn-open-file"
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
              id="btn-open-folder"
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
              id="btn-favorite"
            >
              <span className="top-bar-btn-icon">
                <ToolbarIcon name="favorite" />
              </span>
              <span className="top-bar-btn-label">Favorite</span>
            </button>
            <div id="btn-curation-filter">
              <CurationFilterMenu currentFilter={curationFilter} onSelect={setCurationFilter} />
            </div>
            <button
              className={`top-bar-btn top-bar-btn--labeled has-tooltip ${isSlideshowActive ? 'active' : ''}`}
              onClick={isSlideshowActive ? onTogglePause : onStartSlideshow}
              data-tooltip={
                isSlideshowActive ? `${slideshowToggleLabel} (Space)` : 'Start slideshow (F5)'
              }
              title={isSlideshowActive ? `${slideshowToggleLabel} (Space)` : 'Start slideshow (F5)'}
              aria-label={isSlideshowActive ? slideshowToggleLabel : 'Start slideshow'}
              id="btn-top-slideshow"
              disabled={!canStartSlideshow}
            >
              <span className="top-bar-btn-icon">
                <ToolbarIcon
                  name={isSlideshowActive && !isSlideshowPaused ? 'pause' : 'slideshow'}
                />
              </span>
              <span className="top-bar-btn-label">
                {isSlideshowActive ? (isSlideshowPaused ? 'Resume' : 'Pause') : 'Slideshow'}
              </span>
            </button>
            {isSlideshowActive && (
              <button
                className="top-bar-btn top-bar-btn--labeled has-tooltip"
                onClick={() => void onStopSlideshow()}
                data-tooltip="Stop slideshow (Esc)"
                title="Stop slideshow (Esc)"
                aria-label="Stop slideshow"
                id="btn-top-stop-slideshow"
                type="button"
              >
                <span className="top-bar-btn-icon">
                  <ToolbarIcon name="stop" />
                </span>
                <span className="top-bar-btn-label">Stop</span>
              </button>
            )}
            <button
              className="top-bar-btn top-bar-btn--labeled has-tooltip"
              onClick={toggleFullscreen}
              data-tooltip="Toggle fullscreen (F11)"
              title="Toggle fullscreen (F11)"
              aria-label="Toggle fullscreen"
              id="btn-fullscreen"
            >
              <span className="top-bar-btn-icon">{isFullscreen ? '🗗' : '⛶'}</span>
              <span className="top-bar-btn-label">Full</span>
            </button>
            <button
              className={`top-bar-btn top-bar-btn--labeled has-tooltip ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode(viewMode === 'viewer' ? 'grid' : 'viewer')}
              data-tooltip="Grid view (G)"
              title="Grid view (G)"
              aria-label="Toggle grid view"
              id="btn-grid"
            >
              <span className="top-bar-btn-icon">▦</span>
              <span className="top-bar-btn-label">Grid</span>
            </button>
            <button
              className={`top-bar-btn top-bar-btn--labeled has-tooltip ${viewMode === 'compare' ? 'active' : ''}`}
              onClick={() => {
                if (viewMode === 'compare') {
                  exitCompareMode();
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
              id="btn-compare"
              disabled={!canEnterCompareMode}
            >
              <span className="top-bar-btn-icon">≡</span>
              <span className="top-bar-btn-label">Compare</span>
            </button>
            <button
              className={`top-bar-btn top-bar-btn--labeled has-tooltip ${isCropMode || pendingCropPreview ? 'active' : ''}`}
              onClick={handleToggleCrop}
              data-tooltip={
                cropDisabledByRotation
                  ? viewMode === 'compare'
                    ? 'Crop is unavailable in compare view'
                    : 'Crop is unavailable while rotation preview is active'
                  : 'Crop image'
              }
              title={
                cropDisabledByRotation
                  ? viewMode === 'compare'
                    ? 'Crop is unavailable in compare view'
                    : 'Crop is unavailable while rotation preview is active'
                  : 'Crop image'
              }
              aria-label="Toggle crop mode"
              id="btn-crop"
              disabled={cropDisabledByRotation}
            >
              <span className="top-bar-btn-icon">✂</span>
              <span className="top-bar-btn-label">Crop</span>
            </button>
            <button
              className={`top-bar-btn top-bar-btn--labeled has-tooltip ${isCurrentMarked ? 'active' : ''}`}
              onClick={() => currentImagePath && toggleMarkedPath(currentImagePath)}
              data-tooltip={isCurrentMarked ? 'Unmark current image (M)' : 'Mark current image (M)'}
              title={isCurrentMarked ? 'Unmark current image (M)' : 'Mark current image (M)'}
              aria-label={isCurrentMarked ? 'Unmark current image' : 'Mark current image'}
              id="btn-mark-current"
            >
              <span className="top-bar-btn-icon">+</span>
              <span className="top-bar-btn-label">{isCurrentMarked ? 'Marked' : 'Mark'}</span>
            </button>
            {markedPaths.length > 0 && (
              <details
                className="top-bar-menu marked-actions-trigger"
                ref={markedActionsMenuRef}
                onToggle={(event) => setIsMarkedActionsMenuOpen(event.currentTarget.open)}
              >
                <summary
                  className="image-counter marked-actions-summary"
                  aria-label="Marked image actions"
                  role="button"
                >
                  {markedPaths.length} marked
                </summary>
                {isMarkedActionsMenuOpen && (
                  <div
                    className="top-bar-menu-panel marked-actions-panel"
                    role="toolbar"
                    aria-label="Marked image actions"
                  >
                    <div className="marked-actions-panel-count" aria-live="polite">
                      {markedPaths.length} marked
                      {isCurrentMarked ? ' current' : ''}
                    </div>
                    <button
                      className="top-bar-menu-item"
                      onClick={markAllVisibleImages}
                      type="button"
                    >
                      Mark All
                    </button>
                    <button className="top-bar-menu-item" onClick={jumpToLastMarked} type="button">
                      Jump to Last Marked
                    </button>
                    <button className="top-bar-menu-item" onClick={clearMarkedPaths} type="button">
                      Clear
                    </button>
                    <span className="contact-sheet-bulk-divider" aria-hidden="true" />
                    {renderMarkedTransferSubmenu('copy')}
                    {renderMarkedTransferSubmenu('move')}
                    <button
                      className="top-bar-menu-item"
                      onClick={() => void handleDeleteMarked()}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </details>
            )}
            {pinnedSecondaryActions.map((action) => (
              <div key={action.id} className="top-bar-menu-entry top-bar-menu-entry--pinned">
                {action.pinnedNode}
              </div>
            ))}
            <details className="top-bar-menu" ref={moreMenuRef}>
              <summary
                className="top-bar-btn top-bar-btn--labeled has-tooltip"
                aria-label="More actions"
                data-tooltip="More actions"
                title="More actions"
                id="btn-more-actions"
              >
                <span className="top-bar-btn-icon">...</span>
                <span className="top-bar-btn-label">More</span>
              </summary>
              <div
                className={`top-bar-menu-panel top-bar-menu-panel--stacked more-actions-panel ${isCustomizingToolbar ? 'is-customizing' : ''}`}
              >
                <div className="more-actions-scroll">
                  <FolderSortMenu />
                  <div className="context-menu-divider" role="separator" />
                  {SECONDARY_ACTION_GROUPS.map((group) => {
                    const groupedActions = secondaryActionDefinitions.filter(
                      (action) => action.group === group.id && action.id !== 'settings'
                    );
                    if (groupedActions.length === 0) {
                      return null;
                    }

                    return (
                      <section key={group.id} className="top-bar-menu-section">
                        <div className="top-bar-menu-section-label">{group.label}</div>
                        {groupedActions.map((action) => {
                          const pinnableActionId = isPinnableActionId(action.id) ? action.id : null;
                          const isPinned = pinnableActionId
                            ? pinnedToolbarActions.includes(pinnableActionId)
                            : false;
                          return (
                            <div
                              key={action.id}
                              className={`top-bar-menu-entry top-bar-menu-entry--row ${action.id === 'delete' ? 'top-bar-menu-entry--danger' : ''}`}
                            >
                              <span className="top-bar-menu-icon" aria-hidden="true">
                                <ToolbarIcon name={action.icon} />
                              </span>
                              <div className="top-bar-menu-action">{action.menuNode}</div>
                              {pinnableActionId && (
                                <button
                                  className={`top-bar-pin-toggle ${isPinned ? 'active' : ''}`}
                                  onClick={() => void togglePinnedAction(pinnableActionId)}
                                  type="button"
                                  aria-label={
                                    isPinned ? `Unpin ${action.label}` : `Pin ${action.label}`
                                  }
                                  title={isPinned ? `Unpin ${action.label}` : `Pin ${action.label}`}
                                >
                                  <ToolbarIcon name="pin" />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </section>
                    );
                  })}
                </div>
                <div className="more-actions-footer">
                  <button
                    className={`top-bar-menu-item customize-toolbar-button ${isCustomizingToolbar ? 'active' : ''}`}
                    type="button"
                    onClick={() => setIsCustomizingToolbar((value) => !value)}
                    aria-pressed={isCustomizingToolbar}
                  >
                    <span className="top-bar-menu-icon" aria-hidden="true">
                      <ToolbarIcon name="pin" />
                    </span>
                    <span>{isCustomizingToolbar ? 'Done customizing' : 'Customize toolbar…'}</span>
                  </button>
                  {(() => {
                    const settingsAction = secondaryActionsById.get('settings');
                    const isPinned = pinnedToolbarActions.includes('settings');
                    if (!settingsAction) return null;
                    return (
                      <div className="top-bar-menu-entry top-bar-menu-entry--row more-actions-settings-row">
                        <span className="top-bar-menu-icon" aria-hidden="true">
                          <ToolbarIcon name={settingsAction.icon} />
                        </span>
                        <div className="top-bar-menu-action">{settingsAction.menuNode}</div>
                        <button
                          className={`top-bar-pin-toggle ${isPinned ? 'active' : ''}`}
                          onClick={() => void togglePinnedAction('settings')}
                          type="button"
                          aria-label={isPinned ? 'Unpin Settings' : 'Pin Settings'}
                          title={isPinned ? 'Unpin Settings' : 'Pin Settings'}
                        >
                          <ToolbarIcon name="pin" />
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>

      {contextMenu.open && (
        <div
          className="context-menu"
          role="menu"
          aria-label="Image actions"
          ref={contextMenuRef}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="context-menu-section" role="presentation" aria-label="Selection actions">
            <div className="context-menu-section-label">Selection</div>
            <button
              className="top-bar-menu-item context-menu-item"
              onClick={() => {
                if (currentImagePath) {
                  toggleMarkedPath(contextMenuPath ?? currentImagePath);
                }
                closeContextMenu();
              }}
              role="menuitem"
              type="button"
            >
              <MenuLabel
                label={isContextMenuPathMarked ? 'Unmark Current Image' : 'Mark Current Image'}
                icon="pin"
                shortcut="M"
              />
            </button>
          </div>
          <div className="context-menu-divider" role="separator" />
          <div className="context-menu-section" role="presentation" aria-label="Copy actions">
            <div className="context-menu-section-label">Copy</div>
            <button
              className="top-bar-menu-item context-menu-item"
              onClick={async () => {
                await copyCurrentImage(contextMenuPath);
                closeContextMenu();
              }}
              role="menuitem"
              type="button"
            >
              <MenuLabel label="Copy Image" icon="copy" />
            </button>
            <button
              className="top-bar-menu-item context-menu-item"
              onClick={async () => {
                await copyCurrentImageFileName(contextMenuPath);
                closeContextMenu();
              }}
              role="menuitem"
              type="button"
            >
              <MenuLabel label="Copy Filename" icon="file" />
            </button>
            <button
              className="top-bar-menu-item context-menu-item"
              onClick={async () => {
                await copyCurrentImagePath(contextMenuPath);
                closeContextMenu();
              }}
              role="menuitem"
              type="button"
            >
              <MenuLabel label="Copy Path" icon="copy" shortcut="Ctrl+Shift+C" />
            </button>
          </div>
          <div className="context-menu-divider" role="separator" />
          <div className="context-menu-section" role="presentation" aria-label="Open actions">
            <div className="context-menu-section-label">Open</div>
            <button
              className="top-bar-menu-item context-menu-item"
              onClick={async () => {
                await revealCurrentImage(contextMenuPath);
                closeContextMenu();
              }}
              role="menuitem"
              type="button"
            >
              <MenuLabel label="Reveal" icon="reveal" shortcut="Ctrl+Shift+O" />
            </button>
            <button
              className="top-bar-menu-item context-menu-item"
              onClick={async () => {
                await openCurrentImageInEditor(
                  contextMenuPath,
                  externalEditorPath,
                  externalEditorLabel
                );
                closeContextMenu();
              }}
              role="menuitem"
              type="button"
            >
              <MenuLabel
                label={externalEditorLabel ? `Edit in ${externalEditorLabel}` : 'Edit'}
                icon="edit"
                shortcut="Ctrl+E"
              />
            </button>
          </div>
          <div className="context-menu-divider" role="separator" />
          <div className="context-menu-section" role="presentation" aria-label="Danger actions">
            <div className="context-menu-section-label">Danger</div>
            <button
              className="top-bar-menu-item context-menu-item context-menu-item-danger"
              onClick={() => void handleContextMenuDelete()}
              role="menuitem"
              type="button"
            >
              <MenuLabel label="Delete" icon="delete" shortcut="Delete" />
            </button>
          </div>
        </div>
      )}

      {showProjectorGridPrompt && (
        <div className="projector-grid-prompt-overlay" role="presentation">
          <div className="projector-grid-prompt" role="dialog" aria-label="Projector mode setup">
            <div className="projector-grid-prompt-header">
              <h3>Projector mode works best with grid view</h3>
            </div>
            <div className="projector-grid-prompt-body">
              <p>
                Switch the main window to grid view so you can keep browsing there while the
                projector updates on the second screen?
              </p>
              <label className="projector-grid-prompt-checkbox">
                <input
                  checked={skipProjectorGridPrompt}
                  onChange={(event) => setSkipProjectorGridPrompt(event.target.checked)}
                  type="checkbox"
                />
                <span>Don&apos;t show this again</span>
              </label>
            </div>
            <div className="projector-grid-prompt-actions">
              <button
                className="setting-button-secondary"
                onClick={() => void handleProjectorPromptKeepCurrentView()}
                type="button"
              >
                Keep Current View
              </button>
              <button
                className="setting-button-primary"
                onClick={() => void handleProjectorPromptSwitchToGrid()}
                type="button"
              >
                Switch to Grid
              </button>
            </div>
          </div>
        </div>
      )}

      {showExif && currentImagePath && (
        <ExifPanel
          filePath={currentImagePath}
          caption={imageCaption}
          onCopyCaption={() => void handleCopyCaption()}
          hasThumbnails={showThumbnails && viewMode === 'viewer'}
          refreshToken={exifRefreshToken}
          onClose={() => setShowExif(false)}
        />
      )}

      {imageCaption && showImageCaptions && viewMode === 'viewer' && !isCropMode && !showExif && (
        <ImageCaptionOverlay
          caption={imageCaption}
          hasThumbnails={showThumbnails}
          onCopy={() => void handleCopyCaption()}
        />
      )}

      {images.length > 1 && (
        <>
          <button
            className="nav-arrow left"
            onClick={onPrev}
            aria-label="Previous image"
            id="btn-prev"
          >
            ‹
          </button>
          <button
            className="nav-arrow right"
            onClick={onNext}
            aria-label="Next image"
            id="btn-next"
          >
            ›
          </button>
        </>
      )}

      {isSlideshowActive && (
        <div
          className={`slideshow-indicator ${isSlideshowPaused ? 'paused' : ''}`}
          role="status"
          aria-live="polite"
        >
          {isSlideshowPaused ? 'Paused' : 'Slideshow'} ·{' '}
          {shuffleSlideshow ? 'Shuffle' : slideshowDirection === 'reverse' ? 'Reverse' : 'Forward'}{' '}
          · {slideshowIntervalSeconds}s
        </div>
      )}

      <div className="bottom-controls" role="toolbar" aria-label="Image controls">
        <button
          className="control-btn has-tooltip"
          onClick={onFirst}
          data-tooltip="First image (Home)"
          title="First image (Home)"
          aria-label="First image"
          id="btn-ctrl-first"
        >
          <ToolbarIcon name="first" />
        </button>

        <button
          className="control-btn has-tooltip"
          onClick={onPrev}
          data-tooltip="Previous (Left Arrow)"
          title="Previous (←)"
          aria-label="Previous image"
          id="btn-ctrl-prev"
        >
          <ToolbarIcon name="previous" />
        </button>

        <button
          className="control-btn has-tooltip"
          onClick={onNext}
          data-tooltip="Next (Right Arrow)"
          title="Next (Right Arrow)"
          aria-label="Next image"
          id="btn-ctrl-next"
        >
          <ToolbarIcon name="next" />
        </button>

        <button
          className="control-btn has-tooltip"
          onClick={onLast}
          data-tooltip="Last image (End)"
          title="Last image (End)"
          aria-label="Last image"
          id="btn-ctrl-last"
        >
          <ToolbarIcon name="last" />
        </button>

        <button
          className={`control-btn has-tooltip ${shuffleSlideshow ? 'active' : ''}`}
          onClick={handleToggleSlideshowShuffle}
          data-tooltip={slideshowShuffleLabel}
          title={slideshowShuffleLabel}
          aria-label={slideshowShuffleLabel}
          id="btn-slideshow-shuffle"
          disabled={!canStartSlideshow}
          type="button"
        >
          <ToolbarIcon name="shuffle" />
        </button>

        <SlideshowOptions
          menuRef={slideshowOptionsMenuRef}
          canStart={canStartSlideshow}
          shuffle={shuffleSlideshow}
          direction={slideshowDirection}
          repeat={loopSlideshow}
          interval={slideshowIntervalSeconds}
          autoFullscreen={autoFullscreenOnSlideshow}
          updateSettings={updateSettings}
        />

        {!isSlideshowActive ? (
          <button
            className="control-btn has-tooltip"
            onClick={onStartSlideshow}
            data-tooltip="Start slideshow (F5)"
            title="Start slideshow (F5)"
            aria-label="Start slideshow"
            id="btn-start-slideshow"
          >
            <ToolbarIcon name="slideshow" />
          </button>
        ) : (
          <>
            <button
              className={`control-btn has-tooltip ${isSlideshowPaused ? '' : 'active'}`}
              onClick={onTogglePause}
              data-tooltip={`${slideshowToggleLabel} (Space)`}
              title={`${slideshowToggleLabel} (Space)`}
              aria-label={slideshowToggleLabel}
              id="btn-toggle-slideshow"
            >
              <ToolbarIcon name={isSlideshowPaused ? 'slideshow' : 'pause'} />
            </button>
            <button
              className="control-btn has-tooltip"
              onClick={() => void onStopSlideshow()}
              data-tooltip="Stop slideshow (Esc)"
              title="Stop slideshow (Esc)"
              aria-label="Stop slideshow"
              id="btn-stop-slideshow"
              type="button"
            >
              <ToolbarIcon name="stop" />
            </button>
          </>
        )}

        <div className="control-divider" />

        <button
          className="control-btn has-tooltip"
          onPointerDown={stopZoomControlPointerDown}
          onPointerUp={activateZoomControlOnPointerUp('zoom-out', zoomOut)}
          onMouseUp={activateZoomControlOnMouseUp('zoom-out', zoomOut)}
          onClick={activateZoomControlOnClick('zoom-out', zoomOut)}
          data-tooltip="Zoom out (-)"
          title="Zoom out (-)"
          aria-label="Zoom out"
          id="btn-zoom-out"
          type="button"
        >
          <ToolbarIcon name="zoomOut" />
        </button>

        <button
          className="zoom-display zoom-display--button has-tooltip"
          onPointerDown={stopZoomControlPointerDown}
          onPointerUp={activateZoomControlOnPointerUp('zoom-reset', resetZoom)}
          onMouseUp={activateZoomControlOnMouseUp('zoom-reset', resetZoom)}
          onClick={activateZoomControlOnClick('zoom-reset', resetZoom)}
          data-tooltip="Recenter and fit"
          title="Recenter and fit"
          aria-label="Reset zoom to fit"
          type="button"
        >
          {getZoomDisplay()}
        </button>

        <button
          className="control-btn has-tooltip"
          onPointerDown={stopZoomControlPointerDown}
          onPointerUp={activateZoomControlOnPointerUp('zoom-in', zoomIn)}
          onMouseUp={activateZoomControlOnMouseUp('zoom-in', zoomIn)}
          onClick={activateZoomControlOnClick('zoom-in', zoomIn)}
          data-tooltip="Zoom in (+)"
          title="Zoom in (+)"
          aria-label="Zoom in"
          id="btn-zoom-in"
          type="button"
        >
          <ToolbarIcon name="zoomIn" />
        </button>

        {shouldMoveRotateControls ? (
          <div className="control-divider" />
        ) : (
          <>
            <div className="control-divider control-divider--rotate-start" />

            <div className="control-group control-group--rotate" role="group" aria-label="Rotation">
              <button
                className="control-btn has-tooltip"
                onClick={() => useViewerStore.getState().rotateCounterClockwise()}
                data-tooltip="Rotate counter-clockwise (L)"
                title="Rotate counter-clockwise (L)"
                aria-label="Rotate counter-clockwise"
                id="btn-rotate-l"
              >
                <ToolbarIcon name="rotateCcw" />
              </button>

              <button
                className="control-btn has-tooltip"
                onClick={() => useViewerStore.getState().rotateClockwise()}
                data-tooltip="Rotate clockwise (R)"
                title="Rotate clockwise (R)"
                aria-label="Rotate clockwise"
                id="btn-rotate-r"
              >
                <ToolbarIcon name="rotateCw" />
              </button>
            </div>
          </>
        )}

        {hasPendingEdits && (
          <button
            className="control-btn has-tooltip"
            onClick={() => {
              if (currentImagePath) {
                clearPendingEdits(currentImagePath);
              }
            }}
            title="Reset pending edits"
            aria-label="Reset pending edits"
            id="btn-reset-edits"
          >
            Reset
          </button>
        )}

        {canCommitPendingEdits && (
          <button
            className="control-btn active has-tooltip"
            onClick={() => {
              void handleSaveCurrentEdits();
            }}
            title="Save pending edits"
            aria-label="Save pending edits"
            id="btn-save-edits"
          >
            💾
          </button>
        )}

        {!shouldMoveRotateControls && (
          <div className="control-divider control-divider--rotate-end" />
        )}

        <button
          className={`control-btn has-tooltip ${zoomMode === 'fit' ? 'active' : ''}`}
          onClick={resetZoom}
          data-tooltip="Recenter and fit (0)"
          title="Recenter and fit (0)"
          aria-label="Recenter and fit"
          id="btn-zoom-fit"
        >
          <ToolbarIcon name="fit" />
        </button>

        <button
          className={`control-btn control-btn--text has-tooltip ${zoomMode === 'actual' ? 'active' : ''}`}
          onClick={() => setZoomMode('actual')}
          data-tooltip="Actual size (1)"
          title="Actual size (1)"
          aria-label="Actual size"
          id="btn-zoom-actual"
        >
          1:1
        </button>

        {viewMode === 'compare' && (
          <button
            className={`control-btn control-btn--text has-tooltip ${isCompareZoomLocked ? 'active' : ''}`}
            onClick={() => setCompareZoomLocked(!isCompareZoomLocked)}
            data-tooltip={
              isCompareZoomLocked
                ? 'Unlock compare zoom while switching images'
                : 'Lock compare zoom while switching images'
            }
            title={
              isCompareZoomLocked
                ? 'Unlock compare zoom while switching images'
                : 'Lock compare zoom while switching images'
            }
            aria-label={isCompareZoomLocked ? 'Unlock compare zoom' : 'Lock compare zoom'}
            id="btn-compare-zoom-lock"
            type="button"
          >
            <ToolbarIcon name="pin" />
            <span className="sr-only">
              {isCompareZoomLocked ? 'Unlock compare zoom' : 'Lock compare zoom'}
            </span>
          </button>
        )}

        <QualityExportMenu
          currentImagePath={currentImagePath}
          menuRef={qualityMenuRef}
          onQueueOpened={() => setIsEditQueuePanelOpen(true)}
        />

        <details
          className="edit-queue-menu"
          ref={editQueueMenuRef}
          open={isEditQueuePanelOpen}
          onToggle={(event) => setIsEditQueuePanelOpen(event.currentTarget.open)}
        >
          <summary
            className={`control-btn control-btn--text has-tooltip ${
              editQueueIsRunning || editQueueActiveCount > 0 || editQueueFailedCount > 0
                ? 'active'
                : ''
            }`}
            data-tooltip="Editing queue"
            title="Editing queue"
            aria-label="Editing queue"
            id="btn-edit-queue"
          >
            Queue
            {editQueueActiveCount > 0
              ? ` ${editQueueActiveCount}`
              : editQueueFailedCount > 0
                ? ` !${editQueueFailedCount}`
                : ''}
          </summary>
          {isEditQueuePanelOpen && <EditQueuePanel />}
        </details>

        {(isCropMode || pendingCropPreview) && (
          <>
            <div className="control-divider" />
            <details className="crop-actions-menu" ref={cropActionsMenuRef}>
              <summary
                className={`control-btn control-btn--text has-tooltip ${isCropMode ? 'active' : ''}`}
                data-tooltip="Crop actions"
                title="Crop actions"
                aria-label="Crop actions"
                id="btn-crop-actions"
              >
                Crop
              </summary>
              <div className="crop-actions-panel">
                <label className="crop-actions-field">
                  <span>Aspect</span>
                  <select
                    className="crop-aspect-select"
                    aria-label="Crop aspect ratio"
                    value={cropAspectRatio}
                    onChange={(event) =>
                      setCropAspectRatio(
                        event.target.value as 'free' | '1:1' | '4:3' | '3:2' | '16:9'
                      )
                    }
                    disabled={!isCropMode}
                  >
                    <option value="free">Free</option>
                    <option value="1:1">1:1</option>
                    <option value="4:3">4:3</option>
                    <option value="3:2">3:2</option>
                    <option value="16:9">16:9</option>
                  </select>
                </label>
                <div className="crop-actions-grid">
                  <button
                    className="setting-button-secondary"
                    onClick={resetCrop}
                    aria-label="Reset crop"
                    id="btn-crop-reset"
                    type="button"
                  >
                    Reset
                  </button>
                  {isCropMode ? (
                    <button
                      className="setting-button-primary"
                      onClick={applyCropPreview}
                      aria-label="Preview crop"
                      id="btn-crop-preview"
                      disabled={!canPreviewCrop}
                      type="button"
                    >
                      Preview
                    </button>
                  ) : (
                    <button
                      className="setting-button-secondary"
                      onClick={clearCropPreview}
                      aria-label="Clear crop preview"
                      id="btn-crop-clear-preview"
                      type="button"
                    >
                      Clear
                    </button>
                  )}
                  {isCropMode && (
                    <button
                      className="setting-button-secondary"
                      onClick={() => void handleQueueCroppedCopy()}
                      aria-label="Queue cropped copy"
                      id="btn-crop-queue-copy"
                      disabled={!cropRect}
                      type="button"
                    >
                      Queue
                    </button>
                  )}
                  {isCropMode && (
                    <button
                      className="setting-button-primary"
                      onClick={() => void handleSaveCroppedCopy()}
                      aria-label="Save cropped copy"
                      id="btn-crop-save-copy"
                      disabled={!cropRect}
                      type="button"
                    >
                      Save
                    </button>
                  )}
                  {isCropMode && (
                    <button
                      className="setting-button-secondary crop-actions-danger"
                      onClick={() => void handleOverwriteCrop()}
                      aria-label="Overwrite original with crop"
                      id="btn-crop-overwrite"
                      disabled={!cropRect}
                      type="button"
                    >
                      Overwrite
                    </button>
                  )}
                </div>
              </div>
            </details>
          </>
        )}

        {shouldUseCompactBottomControls ? (
          <details
            className="bottom-controls-menu bottom-controls-menu--compact"
            ref={compactBottomMenuRef}
          >
            <summary
              className="control-btn has-tooltip"
              data-tooltip="More controls"
              title="More controls"
              aria-label="More controls"
            >
              <ToolbarIcon name="more" />
            </summary>
            <div className="bottom-controls-menu-panel">
              {shouldMoveRotateControls && (
                <div className="bottom-menu-section bottom-menu-section--visible">
                  <div className="bottom-menu-label">Rotate</div>
                  <div className="bottom-menu-row">
                    <button
                      className="control-btn"
                      onClick={() => useViewerStore.getState().rotateCounterClockwise()}
                      title="Rotate counter-clockwise (L)"
                      aria-label="Rotate counter-clockwise"
                    >
                      <ToolbarIcon name="rotateCcw" />
                    </button>
                    <button
                      className="control-btn"
                      onClick={() => useViewerStore.getState().rotateClockwise()}
                      title="Rotate clockwise (R)"
                      aria-label="Rotate clockwise"
                    >
                      <ToolbarIcon name="rotateCw" />
                    </button>
                  </div>
                </div>
              )}
              <div className="bottom-menu-section bottom-menu-section--visible">
                <div className="bottom-menu-label">Rating</div>
                <RatingControls
                  currentRating={currentRating}
                  onSetRating={(value) => void handleSetRating(value)}
                />
              </div>
            </div>
          </details>
        ) : (
          <>
            <div className="control-divider control-divider--rating" />
            <RatingControls
              currentRating={currentRating}
              onSetRating={(value) => void handleSetRating(value)}
              className="rating-controls--inline"
            />
          </>
        )}
      </div>
    </>
  );
}

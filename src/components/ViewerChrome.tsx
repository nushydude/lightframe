import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import { ExifPanel } from './ExifPanel';
import {
  closeSecondaryWindow,
  type CropRect,
  getImageMetadata,
  getFileName,
  openSecondaryWindow,
  overwriteWithCrop,
  saveCroppedCopy,
  saveScaledCopy,
} from '../services/tauriCommands';
import { useViewerStore } from '../state/viewerStore';
import {
  canSaveRotationForPath,
  copyCurrentImage,
  deleteCurrentImage,
  openCurrentImageInEditor,
  revealCurrentImage,
  showTransferResultMessage,
  transferImagesToDestination,
} from '../services/viewerActions';
import { normalizedToIntegerPixelRect } from '../services/cropMath';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { useProjectorState } from '../hooks/useProjectorState';
import { useCurationStore } from '../state/curationStore';
import { useEditQueueStore } from '../state/editQueueStore';
import { useSettingsStore } from '../state/settingsStore';
import { useToastStore } from '../state/toastStore';
import { getCurationFilterLabel, type CurationFilter } from '../services/curationFilter';
import type { QuickDestination } from '../types/settings';
import { CurationFilterMenu } from './CurationFilterMenu';
import { EditQueuePanel } from './EditQueuePanel';
import { ToolbarIcon } from './ToolbarIcon';

interface ViewerChromeProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecentFolder: (folderPath: string, filter?: CurationFilter) => void | Promise<void>;
  onRefreshFolder: () => void;
  onGoHome: () => void;
  onFirst: () => void;
  onNext: () => void;
  onPrev: () => void;
  onStartSlideshow: () => void | Promise<void>;
  onTogglePause: () => void;
}

type SecondaryToolbarActionId =
  | 'copy'
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

const TOOLBAR_USAGE_STORAGE_KEY = 'lightframe.toolbar-usage.v1';
const SCALE_EXPORT_MAX_DIMENSION = 65_535;
const SCALE_EXPORT_MAX_PIXELS = 50_000_000;
const SCALE_EXPORT_MAX_MEGAPIXELS = SCALE_EXPORT_MAX_PIXELS / 1_000_000;
const QUALITY_PREVIEW_DEBOUNCE_MS = 120;
const COMPACT_BOTTOM_CONTROLS_QUERY = '(max-width: 1120px)';
const COMPACT_ROTATE_CONTROLS_QUERY = '(max-width: 820px)';
const RATING_VALUES = [0, 1, 2, 3, 4, 5] as const;
const SCALE_EXPORT_SOURCE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'tif',
  'avif',
]);
const SCALE_EXPORT_OUTPUT_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'tif',
]);
const SCALE_EXPORT_SOURCE_MESSAGE =
  'Scaled export supports JPEG, PNG, GIF, WebP, BMP, TIFF, and AVIF sources.';
const SCALE_EXPORT_OUTPUT_MESSAGE =
  'Scaled export can save JPEG, PNG, GIF, WebP, BMP, or TIFF files.';
const SCALE_EXPORT_SAVE_FILTERS = [
  { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  { name: 'PNG image', extensions: ['png'] },
  { name: 'WebP image', extensions: ['webp'] },
  { name: 'TIFF image', extensions: ['tif', 'tiff'] },
  { name: 'BMP image', extensions: ['bmp'] },
  { name: 'GIF image', extensions: ['gif'] },
];

interface PreparedScaledCopy {
  outputPath: string;
  width: number;
  height: number;
}

interface PreparedCroppedCopy {
  outputPath: string;
  cropRect: CropRect;
}

function readToolbarUsage(): Partial<Record<SecondaryToolbarActionId, number>> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(TOOLBAR_USAGE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const usage: Partial<Record<SecondaryToolbarActionId, number>> = {};

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        usage[key as SecondaryToolbarActionId] = value;
      }
    }

    return usage;
  } catch (err) {
    console.error('Failed to read toolbar usage:', err);
    return {};
  }
}

function parseScaleDimension(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.round(parsed);
}

function getScaleValidationMessage(width: number | null, height: number | null): string | null {
  if (width == null && height == null) {
    return null;
  }

  if (!width || !height) {
    return 'Width and height must be greater than zero.';
  }

  if (width > SCALE_EXPORT_MAX_DIMENSION || height > SCALE_EXPORT_MAX_DIMENSION) {
    return `Maximum side length is ${SCALE_EXPORT_MAX_DIMENSION}px.`;
  }

  if (width * height > SCALE_EXPORT_MAX_PIXELS) {
    return `Maximum export size is ${SCALE_EXPORT_MAX_MEGAPIXELS} MP.`;
  }

  return null;
}

function getPathExtension(path: string | null): string {
  const fileName = path ? getFileName(path) : '';
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : '';
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

function getScaleExportSourceMessage(path: string | null): string | null {
  const extension = getPathExtension(path);
  if (!extension || SCALE_EXPORT_SOURCE_EXTENSIONS.has(extension)) {
    return null;
  }

  return SCALE_EXPORT_SOURCE_MESSAGE;
}

function getScaleExportOutputMessage(path: string): string | null {
  const extension = getPathExtension(path);
  if (extension && SCALE_EXPORT_OUTPUT_EXTENSIONS.has(extension)) {
    return null;
  }

  return SCALE_EXPORT_OUTPUT_MESSAGE;
}

function getActiveCanvasImageDimensions(): { width: number; height: number } | null {
  const activeImage = getActiveCanvasImageElement();
  const width = activeImage?.naturalWidth ?? 0;
  const height = activeImage?.naturalHeight ?? 0;

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function getActiveCanvasImageElement(): HTMLImageElement | null {
  return document.querySelector('.image-canvas img') as HTMLImageElement | null;
}

function getActiveCanvasImageSource(): string {
  const activeImage = getActiveCanvasImageElement();
  return activeImage?.currentSrc || activeImage?.src || '';
}

function getQualityPreviewFilter(smoothing: number, sharpening: number): string | undefined {
  const filters: string[] = [];
  if (smoothing > 0) {
    filters.push(`blur(${(smoothing / 100) * 1.25}px)`);
  }
  if (sharpening > 0) {
    const contrast = 1 + (sharpening / 100) * 0.35;
    const saturation = 1 + (sharpening / 100) * 0.12;
    filters.push(`contrast(${contrast}) saturate(${saturation})`);
  }

  return filters.length > 0 ? filters.join(' ') : undefined;
}

function QualityPreviewSample({
  currentImagePath,
  smoothing,
  sharpening,
}: {
  currentImagePath: string | null;
  smoothing: number;
  sharpening: number;
}) {
  const [source, setSource] = useState('');
  const [previewSmoothing, setPreviewSmoothing] = useState(smoothing);
  const [previewSharpening, setPreviewSharpening] = useState(sharpening);

  useEffect(() => {
    const activeImage = getActiveCanvasImageElement();
    const refreshSource = () => setSource(getActiveCanvasImageSource());

    refreshSource();
    activeImage?.addEventListener('load', refreshSource);
    const refreshTimer = window.setTimeout(refreshSource, 0);

    return () => {
      activeImage?.removeEventListener('load', refreshSource);
      window.clearTimeout(refreshTimer);
    };
  }, [currentImagePath]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreviewSmoothing(smoothing);
      setPreviewSharpening(sharpening);
    }, QUALITY_PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [smoothing, sharpening]);

  if (!source) {
    return null;
  }

  const filter = getQualityPreviewFilter(previewSmoothing, previewSharpening);

  return (
    <div
      className="quality-preview"
      role="img"
      aria-label="Approximate scaled export preview sample"
    >
      <img src={source} alt="" draggable={false} style={filter ? { filter } : undefined} />
    </div>
  );
}

async function getSourceImageDimensions(
  currentImagePath: string
): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await getImageMetadata(currentImagePath);
    if (metadata?.width && metadata.height) {
      return { width: metadata.width, height: metadata.height };
    }
  } catch (err) {
    console.warn('Failed to read source dimensions for scaled export:', err);
  }

  return getActiveCanvasImageDimensions();
}

function buildScaledDefaultPath(currentImagePath: string, width: number, height: number): string {
  const originalName = getFileName(currentImagePath);
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex >= 0 ? originalName.slice(0, dotIndex) : originalName;
  const originalExtension = getPathExtension(currentImagePath);
  const extension = SCALE_EXPORT_OUTPUT_EXTENSIONS.has(originalExtension)
    ? `.${originalExtension}`
    : '.jpg';

  return currentImagePath.replace(
    originalName,
    `${baseName}-scaled-${width}x${height}${extension}`
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
  onNext,
  onPrev,
  onStartSlideshow,
  onTogglePause,
}: ViewerChromeProps) {
  const {
    currentImagePath,
    images,
    currentIndex,
    folderPath,
    isFullscreen,
    isSlideshowActive,
    isSlideshowPaused,
    zoomMode,
    zoomLevel,
    imageSmoothing,
    imageSharpening,
    isFolderScanning,
    curationFilter,
    setFullscreen,
    setShowSettings,
    setZoomMode,
    resetZoom,
    setImageSmoothing,
    setImageSharpening,
    resetImageAdjustments,
    setCurationFilter,
    zoomIn,
    zoomOut,
    removeImage,
    rotation,
    isCropMode,
    cropRect,
    pendingCropPreview,
    pendingEditsByPath,
    cropAspectRatio,
    viewMode,
    setViewMode,
    enterCompareMode,
    exitCompareMode,
    enterCropMode,
    exitCropMode,
    setCropAspectRatio,
    resetCrop,
    applyCropPreview,
    clearCropPreview,
    clearPendingEdits,
    commitPendingEdits,
  } = useViewerStore();
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
  const showThumbnails = useSettingsStore((state) => state.settings.showThumbnails);
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
  const [toolbarUsage, setToolbarUsage] = useState<
    Partial<Record<SecondaryToolbarActionId, number>>
  >(() => readToolbarUsage());
  const [showProjectorGridPrompt, setShowProjectorGridPrompt] = useState(false);
  const [skipProjectorGridPrompt, setSkipProjectorGridPrompt] = useState(false);
  const [scaleWidth, setScaleWidth] = useState('');
  const [scaleHeight, setScaleHeight] = useState('');
  const [scaleAspectRatio, setScaleAspectRatio] = useState<number | null>(null);
  const [isQualityPanelOpen, setIsQualityPanelOpen] = useState(false);
  const [isEditQueuePanelOpen, setIsEditQueuePanelOpen] = useState(false);
  const { isProjectorOpen, refreshProjectorState } = useProjectorState();
  const moreMenuRef = useRef<HTMLDetailsElement | null>(null);
  const copyToMenuRef = useRef<HTMLDetailsElement | null>(null);
  const moveToMenuRef = useRef<HTMLDetailsElement | null>(null);
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
    setScaleWidth('');
    setScaleHeight('');
    setScaleAspectRatio(null);
  }, [currentImagePath]);

  const closeOverflowMenus = () => {
    if (copyToMenuRef.current) {
      copyToMenuRef.current.open = false;
    }
    if (moveToMenuRef.current) {
      moveToMenuRef.current.open = false;
    }
    if (moreMenuRef.current) {
      moreMenuRef.current.open = false;
    }
  };

  const recordToolbarActionUsage = (actionId: SecondaryToolbarActionId) => {
    setToolbarUsage((current) => {
      const next = {
        ...current,
        [actionId]: (current[actionId] ?? 0) + 1,
      };

      try {
        window.localStorage.setItem(TOOLBAR_USAGE_STORAGE_KEY, JSON.stringify(next));
      } catch (err) {
        console.error('Failed to persist toolbar usage:', err);
      }

      return next;
    });
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
  const parsedScaleWidth = parseScaleDimension(scaleWidth);
  const parsedScaleHeight = parseScaleDimension(scaleHeight);
  const scaleExportSourceMessage = getScaleExportSourceMessage(currentImagePath);
  const scaleValidationMessage = getScaleValidationMessage(parsedScaleWidth, parsedScaleHeight);
  const scaleBlockingMessage = scaleExportSourceMessage ?? scaleValidationMessage;
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

  const handleDelete = async () => {
    await deleteCurrentImage({ currentImagePath, currentIndex, removeImage });
    recordToolbarActionUsage('delete');
    closeOverflowMenus();
  };

  const handleCopy = async () => {
    await copyCurrentImage(currentImagePath);
    recordToolbarActionUsage('copy');
    closeOverflowMenus();
  };

  const handleOpenInEditor = async () => {
    await openCurrentImageInEditor(currentImagePath, externalEditorPath, externalEditorLabel);
    recordToolbarActionUsage('edit');
    closeOverflowMenus();
  };

  const handleReveal = async () => {
    await revealCurrentImage(currentImagePath);
    recordToolbarActionUsage('reveal');
    closeOverflowMenus();
  };

  const handleRefresh = () => {
    onRefreshFolder();
    recordToolbarActionUsage('refresh');
    closeOverflowMenus();
  };

  const handleOpenRecentFolder = async (folderPath: string, filter?: CurationFilter) => {
    await onOpenRecentFolder(folderPath, filter);
    recordToolbarActionUsage('recent-folders');
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
    recordToolbarActionUsage(mode === 'copy' ? 'copy-to' : 'move-to');
    closeOverflowMenus();
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

  const syncScaleDimensionsFromImage = async () => {
    if (!currentImagePath) {
      return null;
    }

    const dimensions = await getSourceImageDimensions(currentImagePath);
    if (!dimensions) {
      return null;
    }

    setScaleAspectRatio(dimensions.width / dimensions.height);
    setScaleWidth(String(dimensions.width));
    setScaleHeight(String(dimensions.height));
    return dimensions;
  };

  const handleScaleWidthChange = (value: string) => {
    setScaleWidth(value);
    const width = parseScaleDimension(value);
    const fallbackDimensions = getActiveCanvasImageDimensions();
    const aspectRatio =
      scaleAspectRatio ??
      (fallbackDimensions ? fallbackDimensions.width / fallbackDimensions.height : null);
    if (width && aspectRatio) {
      setScaleAspectRatio(aspectRatio);
      setScaleHeight(String(Math.max(1, Math.round(width / aspectRatio))));
    }
  };

  const handleScaleHeightChange = (value: string) => {
    setScaleHeight(value);
    const height = parseScaleDimension(value);
    const fallbackDimensions = getActiveCanvasImageDimensions();
    const aspectRatio =
      scaleAspectRatio ??
      (fallbackDimensions ? fallbackDimensions.width / fallbackDimensions.height : null);
    if (height && aspectRatio) {
      setScaleAspectRatio(aspectRatio);
      setScaleWidth(String(Math.max(1, Math.round(height * aspectRatio))));
    }
  };

  const prepareScaledCopy = async (): Promise<PreparedScaledCopy | null> => {
    if (!currentImagePath) {
      return null;
    }

    const sourceMessage = getScaleExportSourceMessage(currentImagePath);
    if (sourceMessage) {
      pushToast({
        title: 'Scale Copy',
        kind: 'error',
        message: sourceMessage,
      });
      return null;
    }

    const fallbackDimensions = await getSourceImageDimensions(currentImagePath);
    const width = parseScaleDimension(scaleWidth) ?? fallbackDimensions?.width ?? null;
    const height = parseScaleDimension(scaleHeight) ?? fallbackDimensions?.height ?? null;
    const validationMessage = getScaleValidationMessage(width, height);

    if (validationMessage) {
      pushToast({
        title: 'Scale Copy',
        kind: 'error',
        message: validationMessage,
      });
      return null;
    }

    if (!width || !height) {
      pushToast({
        title: 'Scale Copy',
        kind: 'error',
        message: 'Unable to determine dimensions for scaled export.',
      });
      return null;
    }

    const outputPath = await save({
      filters: SCALE_EXPORT_SAVE_FILTERS,
      defaultPath: buildScaledDefaultPath(currentImagePath, width, height),
    });

    if (!outputPath) {
      return null;
    }

    const outputMessage = getScaleExportOutputMessage(outputPath);
    if (outputMessage) {
      pushToast({
        title: 'Scale Copy',
        kind: 'error',
        message: outputMessage,
      });
      return null;
    }

    return { outputPath, width, height };
  };

  const handleQueueScaledCopy = async () => {
    const preparedCopy = await prepareScaledCopy();
    if (!preparedCopy || !currentImagePath) {
      return;
    }

    const result = enqueueEditJob({
      kind: 'scaled-copy',
      sourcePath: currentImagePath,
      outputPath: preparedCopy.outputPath,
      width: preparedCopy.width,
      height: preparedCopy.height,
      smoothing: imageSmoothing,
      sharpening: imageSharpening,
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

  const handleSaveScaledCopy = async () => {
    const preparedCopy = await prepareScaledCopy();
    if (!preparedCopy || !currentImagePath) {
      return;
    }

    try {
      await saveScaledCopy(
        currentImagePath,
        preparedCopy.outputPath,
        preparedCopy.width,
        preparedCopy.height,
        imageSmoothing,
        imageSharpening
      );
      pushToast({
        title: 'Scaled Copy Saved',
        kind: 'success',
        message: `Saved scaled copy to ${preparedCopy.outputPath}`,
      });
    } catch (err) {
      console.error('Failed to save scaled copy:', err);
      pushToast({
        title: 'Scaled Copy Failed',
        kind: 'error',
        message: `Failed to save scaled copy: ${err}`,
      });
    }
  };

  const handleToggleInfo = () => {
    setShowExif((value) => !value);
    recordToolbarActionUsage('info');
    closeOverflowMenus();
  };

  const handleOpenSettings = () => {
    setShowSettings(true);
    recordToolbarActionUsage('settings');
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
      recordToolbarActionUsage('projector');
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
      recordToolbarActionUsage('crop');
      closeOverflowMenus();
      return;
    }

    if (pendingCropPreview) {
      clearCropPreview();
    }
    enterCropMode();
    recordToolbarActionUsage('crop');
    closeOverflowMenus();
  };

  const prepareCroppedCopy = async (): Promise<PreparedCroppedCopy | null> => {
    if (!currentImagePath || !cropRect) {
      return null;
    }

    const activeImage = getActiveCanvasImageElement();
    const imageWidth = activeImage?.naturalWidth ?? 0;
    const imageHeight = activeImage?.naturalHeight ?? 0;

    if (imageWidth <= 0 || imageHeight <= 0) {
      pushToast({
        title: 'Crop Copy',
        kind: 'error',
        message: 'Unable to determine image dimensions for crop export.',
      });
      return null;
    }

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

  const handleSaveCroppedCopy = async () => {
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

    const activeImage = document.querySelector('.image-canvas img') as HTMLImageElement | null;
    const imageWidth = activeImage?.naturalWidth ?? 0;
    const imageHeight = activeImage?.naturalHeight ?? 0;
    if (imageWidth <= 0 || imageHeight <= 0) {
      pushToast({
        title: 'Crop Overwrite',
        kind: 'error',
        message: 'Unable to determine image dimensions for crop overwrite.',
      });
      return;
    }

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

  const getZoomDisplay = () => {
    if (zoomMode === 'fit') return 'Fit';
    if (zoomMode === 'fill') return 'Fill';
    if (zoomMode === 'actual') return '100%';
    return `${Math.round(zoomLevel * 100)}%`;
  };

  if (!currentImagePath) return null;

  const secondaryActionSortOrder: Record<SecondaryToolbarActionId, number> = {
    refresh: 0,
    'recent-folders': 1,
    reveal: 2,
    copy: 3,
    'copy-to': 4,
    'move-to': 5,
    edit: 6,
    delete: 7,
    projector: 8,
    info: 9,
    settings: 10,
    crop: 11,
  };

  const secondaryActions = [
    {
      id: 'refresh' as const,
      node: (
        <button
          className="top-bar-menu-item"
          onClick={handleRefresh}
          type="button"
          aria-label="Refresh folder"
          disabled={!folderPath}
        >
          Refresh
        </button>
      ),
    },
    {
      id: 'recent-folders' as const,
      node: (
        <details className="top-bar-submenu">
          <summary className="top-bar-menu-item" aria-label="Open recent folder">
            Recent Folders
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
      ),
    },
    {
      id: 'reveal' as const,
      node: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleReveal()}
          type="button"
          aria-label="Show in folder"
        >
          Reveal
        </button>
      ),
    },
    {
      id: 'copy' as const,
      node: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleCopy()}
          type="button"
          aria-label="Copy to Clipboard"
        >
          Copy
        </button>
      ),
    },
    {
      id: 'copy-to' as const,
      node: (
        <details className="top-bar-submenu" ref={copyToMenuRef}>
          <summary className="top-bar-menu-item" aria-label="Copy image to destination">
            Copy To
          </summary>
          <div className="top-bar-submenu-panel">
            {quickDestinations.length === 0 ? (
              <>
                <span className="top-bar-menu-empty">
                  No destinations configured. Add folders in Settings {'>'} Quick Destinations.
                </span>
                <button className="top-bar-menu-item" onClick={handleOpenSettings} type="button">
                  Open Settings
                </button>
              </>
            ) : (
              quickDestinations.map((destination) => (
                <button
                  key={destination.id}
                  className="top-bar-menu-item"
                  onClick={() => void handleQuickTransfer(destination, 'copy')}
                  type="button"
                >
                  {destination.label}
                </button>
              ))
            )}
          </div>
        </details>
      ),
    },
    {
      id: 'move-to' as const,
      node: (
        <details className="top-bar-submenu" ref={moveToMenuRef}>
          <summary className="top-bar-menu-item" aria-label="Move image to destination">
            Move To
          </summary>
          <div className="top-bar-submenu-panel">
            {quickDestinations.length === 0 ? (
              <>
                <span className="top-bar-menu-empty">
                  No destinations configured. Add folders in Settings {'>'} Quick Destinations.
                </span>
                <button className="top-bar-menu-item" onClick={handleOpenSettings} type="button">
                  Open Settings
                </button>
              </>
            ) : (
              quickDestinations.map((destination) => (
                <button
                  key={destination.id}
                  className="top-bar-menu-item"
                  onClick={() => void handleQuickTransfer(destination, 'move')}
                  type="button"
                >
                  {destination.label}
                </button>
              ))
            )}
          </div>
        </details>
      ),
    },
    {
      id: 'edit' as const,
      node: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleOpenInEditor()}
          type="button"
          aria-label="Open in external editor"
        >
          {externalEditorLabel ? `Edit in ${externalEditorLabel}` : 'Edit'}
        </button>
      ),
    },
    {
      id: 'delete' as const,
      node: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleDelete()}
          type="button"
          aria-label="Delete image"
        >
          Delete
        </button>
      ),
    },
    {
      id: 'projector' as const,
      node: (
        <button
          className="top-bar-menu-item"
          onClick={() => void handleToggleProjector()}
          type="button"
          aria-label={isProjectorOpen ? 'Close projector mode' : 'Open projector mode'}
        >
          {isProjectorOpen ? 'Projector Off' : 'Projector'}
        </button>
      ),
    },
    {
      id: 'info' as const,
      node: (
        <button
          className="top-bar-menu-item"
          onClick={handleToggleInfo}
          type="button"
          aria-label="Toggle image info panel"
        >
          {showExif ? 'Hide Info' : 'Info'}
        </button>
      ),
    },
    {
      id: 'settings' as const,
      node: (
        <button
          className="top-bar-menu-item"
          onClick={handleOpenSettings}
          type="button"
          aria-label="Open settings"
        >
          Settings
        </button>
      ),
    },
  ].sort((a, b) => {
    const usageDelta = (toolbarUsage[b.id] ?? 0) - (toolbarUsage[a.id] ?? 0);
    if (usageDelta !== 0) {
      return usageDelta;
    }

    return secondaryActionSortOrder[a.id] - secondaryActionSortOrder[b.id];
  });

  return (
    <>
      <div className="top-bar" role="toolbar" aria-label="Image information">
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
              data-tooltip="Back to landing page"
              title="Back to landing page"
              aria-label="Back to landing page"
              id="btn-home"
            >
              <span className="top-bar-btn-icon">⌂</span>
              <span className="top-bar-btn-label">Home</span>
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
                isSlideshowActive ? 'Pause or resume slideshow (Space)' : 'Start slideshow (F5)'
              }
              title={
                isSlideshowActive ? 'Pause or resume slideshow (Space)' : 'Start slideshow (F5)'
              }
              aria-label={isSlideshowActive ? 'Toggle slideshow pause' : 'Start slideshow'}
              id="btn-top-slideshow"
              disabled={!canStartSlideshow}
            >
              <span className="top-bar-btn-icon">
                <ToolbarIcon
                  name={isSlideshowActive && !isSlideshowPaused ? 'pause' : 'slideshow'}
                />
              </span>
              <span className="top-bar-btn-label">Slideshow</span>
            </button>
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
              <div className="top-bar-menu-panel top-bar-menu-panel--stacked">
                {secondaryActions.map((action) => (
                  <div key={action.id} className="top-bar-menu-entry">
                    {action.node}
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>
      </div>

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
          hasThumbnails={showThumbnails && viewMode === 'viewer'}
          refreshToken={exifRefreshToken}
          onClose={() => setShowExif(false)}
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
        <div className={`slideshow-indicator ${isSlideshowPaused ? 'paused' : ''}`}>
          {isSlideshowPaused ? '⏸ Paused' : '▶ Slideshow'}
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
          <button
            className={`control-btn has-tooltip ${isSlideshowPaused ? '' : 'active'}`}
            onClick={onTogglePause}
            data-tooltip="Pause or resume slideshow (Space)"
            title="Pause/Resume slideshow (Space)"
            aria-label="Toggle slideshow pause"
            id="btn-toggle-slideshow"
          >
            <ToolbarIcon name={isSlideshowPaused ? 'slideshow' : 'pause'} />
          </button>
        )}

        <div className="control-divider" />

        <button
          className="control-btn has-tooltip"
          onClick={zoomOut}
          data-tooltip="Zoom out (-)"
          title="Zoom out (-)"
          aria-label="Zoom out"
          id="btn-zoom-out"
        >
          <ToolbarIcon name="zoomOut" />
        </button>

        <button
          className="zoom-display zoom-display--button has-tooltip"
          onClick={resetZoom}
          data-tooltip="Recenter and fit"
          title="Recenter and fit"
          aria-label="Reset zoom to fit"
          type="button"
        >
          {getZoomDisplay()}
        </button>

        <button
          className="control-btn has-tooltip"
          onClick={zoomIn}
          data-tooltip="Zoom in (+)"
          title="Zoom in (+)"
          aria-label="Zoom in"
          id="btn-zoom-in"
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
              if (currentImagePath) {
                void commitPendingEdits(currentImagePath);
              }
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

        <details
          className="quality-menu"
          onToggle={(event) => {
            const isOpen = event.currentTarget.open;
            setIsQualityPanelOpen(isOpen);
            if (isOpen && (!scaleWidth || !scaleHeight)) {
              void syncScaleDimensionsFromImage();
            }
          }}
        >
          <summary
            className={`control-btn control-btn--text has-tooltip ${imageSmoothing > 0 || imageSharpening > 0 ? 'active' : ''}`}
            onClick={(event) => {
              const details = event.currentTarget.parentElement as HTMLDetailsElement | null;
              setIsQualityPanelOpen(!details?.open);
            }}
            data-tooltip="Scaled export quality"
            title="Scaled export quality"
            aria-label="Scaled export quality"
            id="btn-quality-panel"
          >
            HQ
          </summary>
          <div className="quality-panel">
            {isQualityPanelOpen && (
              <QualityPreviewSample
                currentImagePath={currentImagePath}
                smoothing={imageSmoothing}
                sharpening={imageSharpening}
              />
            )}
            <label className="quality-field">
              <span>Export smooth</span>
              <input
                type="range"
                min="0"
                max="100"
                value={imageSmoothing}
                onChange={(event) => setImageSmoothing(Number(event.target.value))}
                aria-label="Export smoothing"
              />
            </label>
            <label className="quality-field">
              <span>Export sharpen</span>
              <input
                type="range"
                min="0"
                max="100"
                value={imageSharpening}
                onChange={(event) => setImageSharpening(Number(event.target.value))}
                aria-label="Export sharpening"
              />
            </label>
            <div className="quality-dimensions">
              <label className="quality-number-field">
                <span>W</span>
                <input
                  type="number"
                  min="1"
                  max={SCALE_EXPORT_MAX_DIMENSION}
                  value={scaleWidth}
                  onChange={(event) => handleScaleWidthChange(event.target.value)}
                  aria-label="Scaled copy width"
                />
              </label>
              <label className="quality-number-field">
                <span>H</span>
                <input
                  type="number"
                  min="1"
                  max={SCALE_EXPORT_MAX_DIMENSION}
                  value={scaleHeight}
                  onChange={(event) => handleScaleHeightChange(event.target.value)}
                  aria-label="Scaled copy height"
                />
              </label>
            </div>
            <div
              className={`quality-limit ${scaleBlockingMessage ? 'warning' : ''}`}
              aria-live="polite"
            >
              {scaleBlockingMessage ?? `Maximum export size is ${SCALE_EXPORT_MAX_MEGAPIXELS} MP.`}
            </div>
            <div className="quality-actions">
              <button
                className="setting-button-secondary"
                type="button"
                onClick={() => void syncScaleDimensionsFromImage()}
              >
                1:1
              </button>
              <button
                className="setting-button-secondary"
                type="button"
                onClick={resetImageAdjustments}
              >
                Reset
              </button>
              <button
                className="setting-button-secondary"
                type="button"
                onClick={() => void handleQueueScaledCopy()}
                disabled={Boolean(scaleBlockingMessage)}
              >
                Queue
              </button>
              <button
                className="setting-button-primary"
                type="button"
                onClick={() => void handleSaveScaledCopy()}
                disabled={Boolean(scaleBlockingMessage)}
              >
                Save
              </button>
            </div>
          </div>
        </details>

        <details
          className="edit-queue-menu"
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
            <details className="crop-actions-menu">
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
          <details className="bottom-controls-menu bottom-controls-menu--compact">
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

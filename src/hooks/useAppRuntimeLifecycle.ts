import { useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useImageNavigation } from './useImageNavigation';
import { useSlideshow } from './useSlideshow';
import { useAppKeyboardShortcuts } from './useAppKeyboardShortcuts';
import { useProjectorState } from './useProjectorState';
import { useProjectorSyncLifecycle } from './useProjectorSyncLifecycle';
import { useAppLifecycleEffects } from './useAppLifecycleEffects';
import { useAppViewerActions } from './useAppViewerActions';
import { useSettingsStore } from '../state/settingsStore';
import type { ImageCuration } from '../types/curation';
import type { AppSettings, PerformanceMode, RecentFolder } from '../types/settings';

export function useAppRuntimeLifecycle({
  currentImagePath,
  markedPaths,
  folderPath,
  showPerformanceTelemetry,
  isFullscreen,
  isSlideshowActive,
  setError,
  setShowControls,
  setShowCommandPalette,
  setShowPerformanceTelemetry,
  setFullscreen,
  setDefaultZoomMode,
  resetZoom,
  syncFavoriteFilter,
  reset,
  theme,
  recentFolders,
  performanceMode,
  defaultFitMode,
  showThumbnails,
  isLoaded,
  loadSettings,
  updateSettings,
  loadCuration,
  toggleFavorite,
  setRating,
  curationByPath,
  favoriteCurationPaths,
}: {
  currentImagePath: string | null;
  markedPaths: string[];
  folderPath: string | null;
  showPerformanceTelemetry: boolean;
  isFullscreen: boolean;
  isSlideshowActive: boolean;
  setError: (error: string | null) => void;
  setShowControls: (value: boolean) => void;
  setShowCommandPalette: (value: boolean) => void;
  setShowPerformanceTelemetry: (value: boolean) => void;
  setFullscreen: (value: boolean) => void;
  setDefaultZoomMode: (mode: 'fit' | 'fill' | 'actual' | 'custom') => void;
  resetZoom: () => void;
  syncFavoriteFilter: (
    curationByPath: Record<string, ImageCuration>,
    favoritePaths: Set<string>
  ) => void;
  reset: () => void;
  theme: AppSettings['theme'];
  recentFolders: RecentFolder[];
  performanceMode: PerformanceMode;
  defaultFitMode: 'fit' | 'fill' | 'actual' | 'custom';
  showThumbnails: boolean;
  isLoaded: boolean;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<unknown>;
  loadCuration: (paths?: string[]) => Promise<void>;
  toggleFavorite: (path: string) => Promise<unknown>;
  setRating: (path: string, rating: number) => Promise<unknown>;
  curationByPath: Record<string, ImageCuration>;
  favoriteCurationPaths: Set<string>;
}) {
  const {
    openImage,
    openImageForStartup,
    openFolder,
    openFilePicker,
    openFolderPicker,
    refreshFolder,
    goNext,
    goPrev,
    goFirst,
    goLast,
  } = useImageNavigation();
  const {
    start: startSlideshow,
    stop: stopSlideshow,
    togglePause: toggleSlideshowPause,
  } = useSlideshow();
  const [isDragOver, setIsDragOver] = useState(false);
  const appWindowRef = useRef(getCurrentWindow());
  const isMainWindowRef = useRef(appWindowRef.current.label === 'main');
  const settingsRef = useRef(useSettingsStore.getState().settings);
  const settingsLoadedRef = useRef(isLoaded);
  const { isProjectorOpen, refreshProjectorState } = useProjectorState();
  const isProjectorWindow = appWindowRef.current.label === 'secondary';
  const isSecondary = useProjectorSyncLifecycle({
    appWindow: appWindowRef.current,
    currentImagePath,
    openImage,
  });
  const handleMouseMove = useAppLifecycleEffects({
    appWindow: appWindowRef.current,
    isMainWindow: isMainWindowRef.current,
    isProjectorWindow,
    isLoaded,
    settingsLoadedRef,
    theme,
    recentFolders,
    performanceMode,
    defaultFitMode,
    setDefaultZoomMode,
    currentImagePath,
    folderPath,
    markedPaths,
    settingsRef,
    isFullscreen,
    isSlideshowActive,
    setShowControls,
    setIsDragOver,
    openFolder,
    openImage,
    showPerformanceTelemetry,
    curationByPath,
    favoriteCurationPaths,
    resetZoom,
    syncFavoriteFilter,
    loadSettings,
    loadCuration,
    openImageForStartup,
    setError,
    updateSettings,
    isSecondary,
  });
  const actions = useAppViewerActions({
    appWindow: appWindowRef.current,
    currentImagePath,
    isFullscreen,
    isSecondary,
    isProjectorOpen,
    openFolder,
    openFilePicker,
    openFolderPicker,
    goNext: () => goNext(),
    goPrev: () => goPrev(),
    goFirst,
    goLast,
    refreshProjectorState,
    startSlideshow,
    setFullscreen,
    setShowPerformanceTelemetry,
    reset,
  });
  useAppKeyboardShortcuts({
    openFilePicker,
    goNext,
    goPrev,
    goFirst,
    goLast,
    refreshFolder,
    startSlideshow: actions.handleStartSlideshow,
    stopSlideshow,
    toggleSlideshowPause,
    openCommandPalette: () => setShowCommandPalette(true),
    togglePerformanceTelemetry: actions.handleTogglePerformanceTelemetry,
    handleExitGridView: actions.handleExitGridView,
    toggleFavorite,
    setRating,
  });
  return {
    ...actions,
    handleMouseMove,
    isSecondary,
    isDragOver,
    goNext,
    goPrev,
    goFirst,
    goLast,
    openFilePicker,
    openFolderPicker,
    refreshFolder,
    stopSlideshow,
    toggleSlideshowPause,
    showThumbnails,
  };
}

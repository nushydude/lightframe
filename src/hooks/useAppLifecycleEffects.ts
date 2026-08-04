import { useEffect, type MutableRefObject } from 'react';
import type { RuntimeWindow } from '../services/runtime/types';
import { useAppStartupLifecycle } from './useAppStartupLifecycle';
import { useWindowPersistence } from './useWindowPersistence';
import {
  useAppWindowTitle,
  useControlsVisibility,
  useDragAndDrop,
  useMarkedSelectionPersistence,
  usePerformanceCacheConfiguration,
  useRecentFoldersJumpList,
  useThemePreference,
  useViewerSynchronization,
} from './useAppWindowEffects';
import type { ImageCuration } from '../types/curation';

type AppLifecycleOptions = Parameters<typeof useAppStartupLifecycle>[0] &
  Parameters<typeof useWindowPersistence>[0] & {
    appWindow: RuntimeWindow;
    isMainWindow: boolean;
    isProjectorWindow: boolean;
    isSecondary: boolean;
    isLoaded: boolean;
    settingsLoadedRef: MutableRefObject<boolean>;
    theme: Parameters<typeof useThemePreference>[0];
    recentFolders: Parameters<typeof useRecentFoldersJumpList>[0]['recentFolders'];
    performanceMode: Parameters<typeof usePerformanceCacheConfiguration>[0];
    defaultFitMode: 'fit' | 'fill' | 'actual' | 'custom';
    setDefaultZoomMode: (mode: 'fit' | 'fill' | 'actual' | 'custom') => void;
    currentImagePath: string | null;
    folderPath: string | null;
    markedPaths: string[];
    settingsRef: Parameters<typeof useMarkedSelectionPersistence>[0]['settingsRef'];
    isFullscreen: boolean;
    isSlideshowActive: boolean;
    setShowControls: (value: boolean) => void;
    setIsDragOver: (value: boolean) => void;
    openFolder: (path: string) => Promise<void>;
    openImage: (path: string) => Promise<void>;
    showPerformanceTelemetry: boolean;
    curationByPath: Record<string, ImageCuration>;
    favoriteCurationPaths: Set<string>;
    resetZoom: () => void;
    syncFavoriteFilter: (
      curationByPath: Record<string, ImageCuration>,
      favoritePaths: Set<string>
    ) => void;
  };

export function useAppLifecycleEffects(options: AppLifecycleOptions) {
  const {
    appWindow,
    isMainWindow,
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
  } = options;

  useEffect(() => {
    settingsLoadedRef.current = isLoaded;
  }, [isLoaded, settingsLoadedRef]);
  useAppStartupLifecycle(options);
  useWindowPersistence(options);
  useThemePreference(theme);
  useRecentFoldersJumpList({
    isMainWindow,
    isLoaded,
    recentFolders,
    updateSettings: options.updateSettings,
  });
  usePerformanceCacheConfiguration(performanceMode);
  useEffect(() => {
    setDefaultZoomMode(isProjectorWindow ? 'fit' : defaultFitMode);
  }, [defaultFitMode, isProjectorWindow, setDefaultZoomMode]);
  useMarkedSelectionPersistence({
    isMainWindow,
    isLoaded,
    folderPath,
    markedPaths,
    settingsRef,
    updateSettings: options.updateSettings,
  });
  useAppWindowTitle({ isMainWindow, isProjectorWindow, currentImagePath, folderPath, appWindow });
  useDragAndDrop({ openFolder, openImage, setIsDragOver });
  const handleMouseMove = useControlsVisibility({
    isFullscreen,
    isSlideshowActive,
    setShowControls,
  });
  useViewerSynchronization({
    currentImagePath,
    isSecondary: options.isSecondary,
    showPerformanceTelemetry,
    curationByPath,
    favoriteCurationPaths,
    resetZoom,
    syncFavoriteFilter,
  });
  return handleMouseMove;
}

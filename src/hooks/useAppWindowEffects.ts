import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isDirectory, updateRecentFoldersJumpList } from '../services/tauriCommands';
import { applyThemePreference } from '../services/themePreference';
import { configureImageAssetCache } from '../services/imageAssetCache';
import { configureThumbnailCache } from '../services/thumbnailCache';
import { getPerformanceModeProfile } from '../services/performanceMode';
import {
  recordStartupFirstImageKnownTelemetry,
  setPerformanceTelemetryEnabled,
} from '../services/performanceTelemetry';
import { updatePersistedMarkedFolders } from '../services/markedSelectionPersistence';
import { mainWindowTitle } from '../services/windowTitle';
import { useSettingsStore } from '../state/settingsStore';
import type { PerformanceMode } from '../types/settings';
import type { ImageCuration } from '../types/curation';

type PendingMarkedSelectionSnapshot = {
  folderPath: string | null;
  markedPaths: string[];
};

export function useRecentFoldersJumpList({
  isMainWindow,
  isLoaded,
  recentFolders,
  updateSettings,
}: {
  isMainWindow: boolean;
  isLoaded: boolean;
  recentFolders: typeof useSettingsStore.getState extends () => infer State
    ? State extends { settings: { recentFolders: infer Folders } }
      ? Folders
      : never
    : never;
  updateSettings: (patch: { recentFolders: typeof recentFolders }) => Promise<unknown>;
}) {
  useEffect(() => {
    if (!isMainWindow || !isLoaded) return;

    let isCancelled = false;
    void updateRecentFoldersJumpList(recentFolders)
      .then(async (removedPaths) => {
        if (isCancelled || removedPaths.length === 0) return;

        const removedKeys = new Set(
          removedPaths.map((path) => path.replace(/\\/g, '/').toLowerCase())
        );
        const currentSettings = useSettingsStore.getState().settings;
        const nextRecentFolders = currentSettings.recentFolders.filter(
          (folder) => !removedKeys.has(folder.path.replace(/\\/g, '/').toLowerCase())
        );
        if (nextRecentFolders.length !== currentSettings.recentFolders.length) {
          await updateSettings({ recentFolders: nextRecentFolders });
        }
      })
      .catch((error) => {
        if (!isCancelled) console.warn('Failed to update Windows recent folders Jump List:', error);
      });

    return () => {
      isCancelled = true;
    };
  }, [isLoaded, isMainWindow, recentFolders, updateSettings]);
}

export function useDragAndDrop({
  openFolder,
  openImage,
  setIsDragOver,
}: {
  openFolder: (path: string) => Promise<void>;
  openImage: (path: string) => Promise<void>;
  setIsDragOver: (value: boolean) => void;
}) {
  useEffect(() => {
    const unlistenDrag = listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
      setIsDragOver(false);
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;

      try {
        if (await isDirectory(paths[0])) await openFolder(paths[0]);
        else await openImage(paths[0]);
      } catch (error) {
        console.error('Failed to stat dragged file:', error);
        await openImage(paths[0]);
      }
    });
    const unlistenDragEnter = listen('tauri://drag-enter', () => setIsDragOver(true));
    const unlistenDragLeave = listen('tauri://drag-leave', () => setIsDragOver(false));

    return () => {
      void unlistenDrag.then((fn) => fn());
      void unlistenDragEnter.then((fn) => fn());
      void unlistenDragLeave.then((fn) => fn());
    };
  }, [openFolder, openImage, setIsDragOver]);
}

export function useControlsVisibility({
  isFullscreen,
  isSlideshowActive,
  setShowControls,
}: {
  isFullscreen: boolean;
  isSlideshowActive: boolean;
  setShowControls: (value: boolean) => void;
}) {
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (isFullscreen || isSlideshowActive) {
      controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000);
    }
  }, [isFullscreen, isSlideshowActive, setShowControls]);

  useEffect(() => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (isFullscreen || isSlideshowActive) {
      setShowControls(true);
      controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000);
    } else {
      setShowControls(true);
    }
  }, [isFullscreen, isSlideshowActive, setShowControls]);

  useEffect(() => {
    return () => {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, []);

  return handleMouseMove;
}

export function useMarkedSelectionPersistence({
  isMainWindow,
  isLoaded,
  folderPath,
  markedPaths,
  settingsRef,
  updateSettings,
}: {
  isMainWindow: boolean;
  isLoaded: boolean;
  folderPath: string | null;
  markedPaths: string[];
  settingsRef: MutableRefObject<ReturnType<typeof useSettingsStore.getState>['settings']>;
  updateSettings: (patch: {
    persistedMarkedFolders: ReturnType<typeof updatePersistedMarkedFolders>;
  }) => Promise<unknown>;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<PendingMarkedSelectionSnapshot | null>(null);

  const persist = useCallback(
    (snapshot: PendingMarkedSelectionSnapshot | null) => {
      if (!snapshot) return;
      settingsRef.current = useSettingsStore.getState().settings;
      const nextFolders = updatePersistedMarkedFolders(
        settingsRef.current,
        snapshot.folderPath,
        snapshot.markedPaths
      );
      if (nextFolders !== settingsRef.current.persistedMarkedFolders) {
        void updateSettings({ persistedMarkedFolders: nextFolders });
      }
    },
    [settingsRef, updateSettings]
  );

  useEffect(() => {
    if (!isMainWindow || !isLoaded) return;
    const nextSnapshot = { folderPath, markedPaths: [...markedPaths] };
    const pendingSnapshot = pendingRef.current;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      if (pendingSnapshot && pendingSnapshot.folderPath !== nextSnapshot.folderPath)
        persist(pendingSnapshot);
    }
    pendingRef.current = nextSnapshot;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const snapshot = pendingRef.current;
      pendingRef.current = null;
      persist(snapshot);
    }, 250);
  }, [folderPath, isLoaded, isMainWindow, markedPaths, persist]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const snapshot = pendingRef.current;
      pendingRef.current = null;
      persist(snapshot);
    };
  }, [persist]);
}

export function useViewerSynchronization({
  currentImagePath,
  isSecondary,
  showPerformanceTelemetry,
  curationByPath,
  favoriteCurationPaths,
  resetZoom,
  syncFavoriteFilter,
}: {
  currentImagePath: string | null;
  isSecondary: boolean;
  showPerformanceTelemetry: boolean;
  curationByPath: Record<string, ImageCuration>;
  favoriteCurationPaths: Set<string>;
  resetZoom: () => void;
  syncFavoriteFilter: (
    curationByPath: Record<string, ImageCuration>,
    favoritePaths: Set<string>
  ) => void;
}) {
  const firstImagePathTelemetryRecordedRef = useRef(false);

  useEffect(() => {
    setPerformanceTelemetryEnabled(showPerformanceTelemetry);
  }, [showPerformanceTelemetry]);
  useEffect(() => {
    syncFavoriteFilter(curationByPath, favoriteCurationPaths);
  }, [curationByPath, favoriteCurationPaths, syncFavoriteFilter]);
  useEffect(() => {
    if (isSecondary && currentImagePath) resetZoom();
  }, [currentImagePath, isSecondary, resetZoom]);
  useEffect(() => {
    if (firstImagePathTelemetryRecordedRef.current || !currentImagePath) return;
    firstImagePathTelemetryRecordedRef.current = true;
    recordStartupFirstImageKnownTelemetry();
  }, [currentImagePath]);
}

export function useAppWindowTitle({
  isMainWindow,
  isProjectorWindow,
  currentImagePath,
  folderPath,
  appWindow,
}: {
  isMainWindow: boolean;
  isProjectorWindow: boolean;
  currentImagePath: string | null;
  folderPath: string | null;
  appWindow: { setTitle: (title: string) => Promise<void> };
}) {
  useEffect(() => {
    if (!isMainWindow || isProjectorWindow || currentImagePath || folderPath) return;
    void appWindow.setTitle(mainWindowTitle()).catch((error) => {
      console.error('Failed to reset window title:', error);
    });
  }, [appWindow, currentImagePath, folderPath, isMainWindow, isProjectorWindow]);
}

export function usePerformanceCacheConfiguration(performanceMode: PerformanceMode) {
  useEffect(() => {
    const profile = getPerformanceModeProfile(performanceMode);
    configureImageAssetCache({ previewCacheBudgetBytes: profile.previewCacheBudgetBytes });
    configureThumbnailCache({ cacheBudgetBytes: profile.thumbnailCacheBudgetBytes });
  }, [performanceMode]);
}

export function useThemePreference(theme: Parameters<typeof applyThemePreference>[0]) {
  useEffect(() => applyThemePreference(theme), [theme]);
}

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from '@tauri-apps/api/window';
import { getMatches } from '@tauri-apps/plugin-cli';
import { confirm } from '@tauri-apps/plugin-dialog';
import { ImageCanvas } from './components/ImageCanvas';
import { ViewerChrome } from './components/ViewerChrome';
import { ThumbnailStrip } from './components/ThumbnailStrip';
import { ContactSheet } from './components/ContactSheet';
import { CompareView } from './components/CompareView';
import { SettingsPanel } from './components/SettingsPanel';
import { EmptyState } from './components/EmptyState';
import { UpdateNotification } from './components/UpdateNotification';
import { CommandPalette } from './components/CommandPalette';
import { PerformanceTelemetryOverlay } from './components/PerformanceTelemetryOverlay';
import { ToastViewport } from './components/ToastViewport';
import { useImageNavigation } from './hooks/useImageNavigation';
import { useSlideshow } from './hooks/useSlideshow';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useProjectorState } from './hooks/useProjectorState';
import { useViewerStore } from './state/viewerStore';
import { useSettingsStore } from './state/settingsStore';
import { useCurationStore } from './state/curationStore';
import { createViewerCommands } from './services/commandRegistry';
import type { CurationFilter } from './services/curationFilter';
import {
  recordStartupFirstImageKnownTelemetry,
  recordStartupCliResolveTelemetry,
  recordStartupInitialImageOpenTelemetry,
  recordStartupSettingsAndCurationLoadTelemetry,
  resetPerformanceTelemetry,
  setPerformanceTelemetryEnabled,
} from './services/performanceTelemetry';
import { configureImageAssetCache } from './services/imageAssetCache';
import { configureThumbnailCache } from './services/thumbnailCache';
import { getPerformanceModeProfile } from './services/performanceMode';
import {
  copyCurrentImagePath,
  copyCurrentImage,
  deleteCurrentImage,
  openCurrentImageInEditor,
  revealCurrentImage,
} from './services/viewerActions';

import {
  closeSecondaryWindow,
  emitStateSync,
  isDirectory,
  openSecondaryWindow,
  requestStateSync,
} from './services/tauriCommands';
import { resolveStartupDecision } from './services/startup';
import {
  displayKeyFromMonitor,
  persistWindowBoundsSafely,
  waitForWindowRestoreBeforeShow,
  windowRestorePlanForDisplays,
} from './services/windowBounds';
import { updatePersistedMarkedFolders } from './services/markedSelectionPersistence';
import { mainWindowTitle } from './services/windowTitle';
import type { AppSettings } from './types/settings';

type PendingMarkedSelectionSnapshot = {
  folderPath: string | null;
  markedPaths: string[];
};

const STARTUP_WINDOW_RESTORE_TIMEOUT_MS = 750;
const STARTUP_WINDOW_SHOW_WATCHDOG_MS = 2000;

// fallow-ignore-next-line complexity
function App() {
  const {
    currentImagePath,
    markedPaths,
    folderPath,
    showSettings,
    showCommandPalette,
    showPerformanceTelemetry,
    errorMessage,
    isFullscreen,
    isSlideshowActive,
    viewMode,
    setError,
    setShowControls,
    setShowCommandPalette,
    setShowPerformanceTelemetry,
    setFullscreen,
    setDefaultZoomMode,
    resetZoom,
    syncFavoriteFilter,
    reset,
  } = useViewerStore();

  const { settings, isLoaded, loadSettings, updateSettings } = useSettingsStore();
  const loadCuration = useCurationStore((state) => state.loadCuration);
  const toggleFavorite = useCurationStore((state) => state.toggleFavorite);
  const setRating = useCurationStore((state) => state.setRating);
  const curationByPath = useCurationStore((state) => state.curationByPath);

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
  const [hasStartupResolved, setHasStartupResolved] = useState(false);
  const [startupShowAttempted, setStartupShowAttempted] = useState(false);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupShowAttemptedRef = useRef(false);
  const firstImagePathTelemetryRecordedRef = useRef(false);
  const appWindowRef = useRef(getCurrentWindow());
  const isMainWindowRef = useRef(appWindowRef.current.label === 'main');
  const settingsRef = useRef(settings);
  const settingsLoadedRef = useRef(isLoaded);
  const saveBoundsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistMarkedPathsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMarkedSelectionRef = useRef<PendingMarkedSelectionSnapshot | null>(null);
  const { isProjectorOpen, refreshProjectorState } = useProjectorState();
  const { showControls } = useViewerStore();
  const [isSecondary, setIsSecondary] = useState(false);
  const isProjectorWindow = appWindowRef.current.label === 'secondary';

  const showMainWindowOnce = useCallback(async () => {
    if (!isMainWindowRef.current || startupShowAttemptedRef.current) return;
    startupShowAttemptedRef.current = true;
    setStartupShowAttempted(true);

    try {
      await appWindowRef.current.show();
    } catch (err) {
      console.error('Failed to show main window:', err);
    }
  }, []);

  const restoreMainWindowBounds = useCallback(
    async (loadedSettings: AppSettings, canContinue: () => boolean) => {
      if (!isMainWindowRef.current || !loadedSettings.rememberWindowBounds) {
        return;
      }

      const [monitor, monitors] = await Promise.all([currentMonitor(), availableMonitors()]);
      if (!canContinue()) {
        return;
      }

      const displayKey = displayKeyFromMonitor(monitor);
      const restorePlan = windowRestorePlanForDisplays(loadedSettings, displayKey, monitors);
      if (!restorePlan) {
        return;
      }

      await appWindowRef.current.setSize(
        new PhysicalSize(restorePlan.bounds.width, restorePlan.bounds.height)
      );
      if (!canContinue()) {
        return;
      }

      await appWindowRef.current.setPosition(
        new PhysicalPosition(restorePlan.bounds.x, restorePlan.bounds.y)
      );
    },
    []
  );

  useEffect(() => {
    settingsRef.current = settings;
    settingsLoadedRef.current = isLoaded;
    if (!settings.rememberWindowBounds && saveBoundsTimerRef.current) {
      clearTimeout(saveBoundsTimerRef.current);
      saveBoundsTimerRef.current = null;
    }
  }, [isLoaded, settings]);

  // Apply theme
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      root.setAttribute('data-theme', settings.theme);
    }
  }, [settings.theme]);

  useEffect(() => {
    const profile = getPerformanceModeProfile(settings.performanceMode);
    configureImageAssetCache({ previewCacheBudgetBytes: profile.previewCacheBudgetBytes });
    configureThumbnailCache({ cacheBudgetBytes: profile.thumbnailCacheBudgetBytes });
  }, [settings.performanceMode]);

  // Keep viewer default zoom mode in sync with settings for newly opened images.
  useEffect(() => {
    setDefaultZoomMode(isProjectorWindow ? 'fit' : settings.defaultFitMode);
  }, [isProjectorWindow, settings.defaultFitMode, setDefaultZoomMode]);

  // Handle CLI arguments (default file association) and resolve startup readiness
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isCancelled = false;

    // fallow-ignore-next-line complexity
    async function init() {
      // Ensure persisted settings are loaded before startup image open.
      const settingsLoadStartedAt = performance.now();
      await Promise.all([loadSettings(), loadCuration()]);
      recordStartupSettingsAndCurationLoadTelemetry(performance.now() - settingsLoadStartedAt);
      if (!isCancelled) {
        const loadedSettings = useSettingsStore.getState().settings;
        const loadedDefaultFitMode = isProjectorWindow ? 'fit' : loadedSettings.defaultFitMode;
        useViewerStore.getState().setDefaultZoomMode(loadedDefaultFitMode);

        let canContinueRestore = true;
        const restoreResult = await waitForWindowRestoreBeforeShow(
          restoreMainWindowBounds(loadedSettings, () => !isCancelled && canContinueRestore),
          STARTUP_WINDOW_RESTORE_TIMEOUT_MS
        );
        if (restoreResult !== 'completed') {
          canContinueRestore = false;
          console.warn(`Skipped startup window restore before show: ${restoreResult}`);
        }
      }

      try {
        if (isMainWindowRef.current) {
          const cliResolveStartedAt = performance.now();
          const matches = await getMatches();
          const startupDecision = resolveStartupDecision(matches.args.file);
          recordStartupCliResolveTelemetry(performance.now() - cliResolveStartedAt);

          if (startupDecision.mode === 'open-image' && startupDecision.filePath) {
            const startupImageOpenStartedAt = performance.now();
            await openImageForStartup(startupDecision.filePath);
            recordStartupInitialImageOpenTelemetry(performance.now() - startupImageOpenStartedAt);
          }
        }
      } catch (err) {
        console.error('Failed to parse CLI args on startup:', err);
        setError(`Failed to parse CLI args on startup: ${err}`);
      } finally {
        if (!isCancelled) {
          setHasStartupResolved(true);
        }
      }
    }

    void init();

    if (isMainWindowRef.current) {
      // Still listen in case another instance sends a message (future single-instance support)
      void listen<string>('open-file', async (event) => {
        await openImage(event.payload);
      })
        .then((fn) => {
          unlisten = fn;
        })
        .catch((err) => console.error('Failed to listen for open-file:', err));
    }

    return () => {
      isCancelled = true;
      if (unlisten) unlisten();
    };
  }, [
    isProjectorWindow,
    loadCuration,
    loadSettings,
    openImage,
    openImageForStartup,
    restoreMainWindowBounds,
    setError,
  ]);

  useEffect(() => {
    if (!isMainWindowRef.current || startupShowAttempted) return;
    const timeoutId = setTimeout(() => {
      void showMainWindowOnce();
    }, STARTUP_WINDOW_SHOW_WATCHDOG_MS);
    return () => clearTimeout(timeoutId);
  }, [showMainWindowOnce, startupShowAttempted]);

  useEffect(() => {
    if (!isMainWindowRef.current || !hasStartupResolved || startupShowAttempted) return;
    void showMainWindowOnce();
  }, [hasStartupResolved, showMainWindowOnce, startupShowAttempted]);

  const persistMarkedSelectionSnapshot = useCallback(
    (snapshot: PendingMarkedSelectionSnapshot | null) => {
      if (!snapshot) {
        return;
      }

      const nextPersistedMarkedFolders = updatePersistedMarkedFolders(
        settingsRef.current,
        snapshot.folderPath,
        snapshot.markedPaths
      );

      if (nextPersistedMarkedFolders !== settingsRef.current.persistedMarkedFolders) {
        void updateSettings({ persistedMarkedFolders: nextPersistedMarkedFolders });
      }
    },
    [updateSettings]
  );

  useEffect(() => {
    if (!isMainWindowRef.current || !isLoaded) {
      return;
    }

    const nextSnapshot: PendingMarkedSelectionSnapshot = {
      folderPath,
      markedPaths: [...markedPaths],
    };
    const pendingSnapshot = pendingMarkedSelectionRef.current;

    if (persistMarkedPathsTimerRef.current) {
      clearTimeout(persistMarkedPathsTimerRef.current);
      persistMarkedPathsTimerRef.current = null;
      if (pendingSnapshot && pendingSnapshot.folderPath !== nextSnapshot.folderPath) {
        persistMarkedSelectionSnapshot(pendingSnapshot);
      }
    }

    pendingMarkedSelectionRef.current = nextSnapshot;
    persistMarkedPathsTimerRef.current = setTimeout(() => {
      persistMarkedPathsTimerRef.current = null;
      const snapshot = pendingMarkedSelectionRef.current;
      pendingMarkedSelectionRef.current = null;
      persistMarkedSelectionSnapshot(snapshot);
    }, 250);
  }, [folderPath, isLoaded, markedPaths, persistMarkedSelectionSnapshot]);

  useEffect(
    () => () => {
      if (persistMarkedPathsTimerRef.current) {
        clearTimeout(persistMarkedPathsTimerRef.current);
        persistMarkedPathsTimerRef.current = null;
      }
      const snapshot = pendingMarkedSelectionRef.current;
      pendingMarkedSelectionRef.current = null;
      persistMarkedSelectionSnapshot(snapshot);
    },
    [persistMarkedSelectionSnapshot]
  );

  useEffect(() => {
    if (!isMainWindowRef.current || isProjectorWindow || currentImagePath || folderPath) {
      return;
    }

    void appWindowRef.current.setTitle(mainWindowTitle()).catch((err) => {
      console.error('Failed to reset window title:', err);
    });
  }, [currentImagePath, folderPath, isProjectorWindow]);

  useEffect(() => {
    if (!isMainWindowRef.current) return;

    let isUnmounted = false;
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;

    const persistWindowBounds = async () => {
      try {
        await persistWindowBoundsSafely({
          isUnmounted: () => isUnmounted,
          isSettingsLoaded: settingsLoadedRef.current,
          isMainWindow: true,
          settings: settingsRef.current,
          readWindowFlags: async () => {
            const [isFullscreen, isMinimized] = await Promise.all([
              appWindowRef.current.isFullscreen(),
              appWindowRef.current.isMinimized(),
            ]);
            return { isFullscreen, isMinimized };
          },
          readWindowBounds: async () => {
            const [position, size] = await Promise.all([
              appWindowRef.current.outerPosition(),
              appWindowRef.current.innerSize(),
            ]);
            return { position, size };
          },
          readDisplayKey: async () => displayKeyFromMonitor(await currentMonitor()),
          updateSettings: async (partial) => {
            if (isUnmounted) return;
            await updateSettings(partial);
          },
        });
      } catch (err) {
        console.error('Failed to persist window bounds:', err);
      }
    };

    const scheduleWindowBoundsPersist = () => {
      if (saveBoundsTimerRef.current) {
        clearTimeout(saveBoundsTimerRef.current);
      }
      saveBoundsTimerRef.current = setTimeout(() => {
        saveBoundsTimerRef.current = null;
        void persistWindowBounds();
      }, 500);
    };

    appWindowRef.current
      .onMoved(() => {
        scheduleWindowBoundsPersist();
      })
      .then((unlisten) => {
        if (isUnmounted) {
          unlisten();
        } else {
          unlistenMoved = unlisten;
        }
      })
      .catch((err) => {
        console.error('Failed to attach window move listener:', err);
      });

    appWindowRef.current
      .onResized(() => {
        scheduleWindowBoundsPersist();
      })
      .then((unlisten) => {
        if (isUnmounted) {
          unlisten();
        } else {
          unlistenResized = unlisten;
        }
      })
      .catch((err) => {
        console.error('Failed to attach window resize listener:', err);
      });

    return () => {
      isUnmounted = true;
      if (saveBoundsTimerRef.current) {
        clearTimeout(saveBoundsTimerRef.current);
        saveBoundsTimerRef.current = null;
      }
      if (unlistenMoved) unlistenMoved();
      if (unlistenResized) unlistenResized();
    };
  }, [updateSettings]);

  // Listen for tauri file drop events
  useEffect(() => {
    const unlistenDrag = listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
      setIsDragOver(false);
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        try {
          const isDir = await isDirectory(paths[0]);
          if (isDir) {
            await openFolder(paths[0]);
          } else {
            await openImage(paths[0]);
          }
        } catch (err) {
          console.error('Failed to stat dragged file:', err);
          await openImage(paths[0]); // fallback
        }
      }
    });

    const unlistenDragEnter = listen('tauri://drag-enter', () => {
      setIsDragOver(true);
    });

    const unlistenDragLeave = listen('tauri://drag-leave', () => {
      setIsDragOver(false);
    });

    return () => {
      void unlistenDrag.then((fn) => fn());
      void unlistenDragEnter.then((fn) => fn());
      void unlistenDragLeave.then((fn) => fn());
    };
  }, [openFolder, openImage]);

  // Auto-hide controls while chrome is floating over the image.
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) {
      clearTimeout(controlsTimerRef.current);
    }
    if (isFullscreen || isSlideshowActive) {
      controlsTimerRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isFullscreen, isSlideshowActive, setShowControls]);

  useEffect(() => {
    if (controlsTimerRef.current) {
      clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
    }

    if (isFullscreen || isSlideshowActive) {
      setShowControls(true);
      controlsTimerRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
      return;
    }

    setShowControls(true);
  }, [isFullscreen, isSlideshowActive, setShowControls]);

  useEffect(() => {
    return () => {
      if (controlsTimerRef.current) {
        clearTimeout(controlsTimerRef.current);
      }
    };
  }, []);

  // Double-click to toggle fullscreen
  const handleDoubleClick = useCallback(
    async (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest('button') ||
        target.closest('.settings-panel') ||
        target.closest('.top-bar') ||
        target.closest('.bottom-controls')
      ) {
        return;
      }
      if (!currentImagePath) return;
      try {
        const newFs = !isFullscreen;
        await appWindowRef.current.setFullscreen(newFs);
        setFullscreen(newFs);
      } catch (err) {
        console.error('Failed to toggle fullscreen:', err);
      }
    },
    [currentImagePath, isFullscreen, setFullscreen]
  );

  const handleGoHome = useCallback(async () => {
    try {
      if (isFullscreen) {
        await appWindowRef.current.setFullscreen(false);
        setFullscreen(false);
      }
    } catch (err) {
      console.error('Failed to exit fullscreen before returning home:', err);
    } finally {
      reset();
    }
  }, [isFullscreen, reset, setFullscreen]);

  const handleOpenRecentFolder = useCallback(
    async (folderPath: string, filter: CurationFilter = 'all') => {
      await openFolder(folderPath, { curationFilter: filter });
    },
    [openFolder]
  );

  const handleToggleFullscreen = useCallback(async () => {
    try {
      const nextFullscreen = !useViewerStore.getState().isFullscreen;
      await appWindowRef.current.setFullscreen(nextFullscreen);
      setFullscreen(nextFullscreen);
    } catch (err) {
      console.error('Failed to toggle fullscreen:', err);
    }
  }, [setFullscreen]);

  const handleTogglePerformanceTelemetry = useCallback(() => {
    const nextValue = !useViewerStore.getState().showPerformanceTelemetry;
    setPerformanceTelemetryEnabled(nextValue);
    setShowPerformanceTelemetry(nextValue);
  }, [setShowPerformanceTelemetry]);

  const handleResetPerformanceTelemetry = useCallback(() => {
    resetPerformanceTelemetry();
  }, []);

  const handleToggleProjector = useCallback(async () => {
    const state = useViewerStore.getState();
    if (state.currentImagePath === null) {
      return;
    }

    if (isSecondary) {
      return;
    }

    if (isProjectorOpen) {
      await closeSecondaryWindow();
    } else {
      await openSecondaryWindow();

      const { openProjectorInGridView } = useSettingsStore.getState().settings;
      if (openProjectorInGridView && useViewerStore.getState().viewMode !== 'grid') {
        useViewerStore.getState().setViewMode('grid');
      }
    }
    await refreshProjectorState();
  }, [isProjectorOpen, isSecondary, refreshProjectorState]);

  const handleCloseProjectorWindow = useCallback(async () => {
    try {
      await closeSecondaryWindow();
      await refreshProjectorState();
    } catch (err) {
      console.error('Failed to close projector window:', err);
    }
  }, [refreshProjectorState]);

  const handleExitGridView = useCallback(async () => {
    if (!isProjectorOpen) {
      useViewerStore.getState().setViewMode('viewer');
      return true;
    }

    const confirmed = await confirm('Leaving grid view will close projector mode. Continue?', {
      title: 'Projector mode',
      kind: 'warning',
    });

    if (!confirmed) {
      return false;
    }

    await closeSecondaryWindow();
    await refreshProjectorState();
    useViewerStore.getState().setViewMode('viewer');
    return true;
  }, [isProjectorOpen, refreshProjectorState]);

  const handleStartSlideshow = useCallback(async () => {
    const state = useViewerStore.getState();
    if (state.viewMode === 'grid') {
      const didExit = await handleExitGridView();
      if (!didExit) {
        return;
      }
    } else if (state.viewMode !== 'viewer') {
      state.setViewMode('viewer');
    }

    await startSlideshow();
  }, [handleExitGridView, startSlideshow]);

  const commandPaletteCommands = useMemo(
    () =>
      createViewerCommands({
        openFilePicker,
        openFolderPicker,
        goNext: () => {
          goNext();
        },
        goPrev: () => {
          goPrev();
        },
        goFirst,
        goLast,
        toggleFullscreen: handleToggleFullscreen,
        saveRotation: () => useViewerStore.getState().saveRotation(),
        revealCurrentImage: () => revealCurrentImage(useViewerStore.getState().currentImagePath),
        openCurrentImageInEditor: () =>
          openCurrentImageInEditor(useViewerStore.getState().currentImagePath),
        copyCurrentImage: () => copyCurrentImage(useViewerStore.getState().currentImagePath),
        copyCurrentImagePath: () =>
          copyCurrentImagePath(useViewerStore.getState().currentImagePath),
        deleteCurrentImage: () =>
          deleteCurrentImage({
            currentImagePath: useViewerStore.getState().currentImagePath,
            currentIndex: useViewerStore.getState().currentIndex,
            removeImage: useViewerStore.getState().removeImage,
          }),
        toggleProjector: handleToggleProjector,
        enterCropMode: () => {
          const state = useViewerStore.getState();
          if (state.viewMode === 'grid') {
            state.setViewMode('viewer');
          }
          state.enterCropMode();
        },
        startSlideshow: handleStartSlideshow,
        toggleCompareMode: () => {
          const state = useViewerStore.getState();
          if (state.viewMode === 'compare') {
            state.exitCompareMode();
            return;
          }
          state.enterCompareMode();
        },
        toggleMarkedCurrent: () => {
          const path = useViewerStore.getState().currentImagePath;
          if (path) {
            useViewerStore.getState().toggleMarkedPath(path);
          }
        },
        togglePerformanceTelemetry: handleTogglePerformanceTelemetry,
        resetPerformanceTelemetry: handleResetPerformanceTelemetry,
      }),
    [
      openFilePicker,
      openFolderPicker,
      goNext,
      goPrev,
      goFirst,
      goLast,
      handleToggleFullscreen,
      handleToggleProjector,
      handleTogglePerformanceTelemetry,
      handleResetPerformanceTelemetry,
      handleStartSlideshow,
    ]
  );

  useEffect(() => {
    setPerformanceTelemetryEnabled(showPerformanceTelemetry);
  }, [showPerformanceTelemetry]);

  useEffect(() => {
    syncFavoriteFilter(curationByPath);
  }, [curationByPath, syncFavoriteFilter]);

  useEffect(() => {
    if (!isSecondary || !currentImagePath) {
      return;
    }

    resetZoom();
  }, [currentImagePath, isSecondary, resetZoom]);

  useEffect(() => {
    if (firstImagePathTelemetryRecordedRef.current || !currentImagePath) {
      return;
    }

    firstImagePathTelemetryRecordedRef.current = true;
    recordStartupFirstImageKnownTelemetry();
  }, [currentImagePath]);

  // Register keyboard shortcuts
  useKeyboardShortcuts({
    openFilePicker,
    openCurrentImageInEditor: () =>
      openCurrentImageInEditor(useViewerStore.getState().currentImagePath),
    copyCurrentImagePath: () => copyCurrentImagePath(useViewerStore.getState().currentImagePath),
    goNext,
    goPrev,
    goFirst,
    goLast,
    refreshFolder,
    deleteCurrentImage: () =>
      deleteCurrentImage({
        currentImagePath: useViewerStore.getState().currentImagePath,
        currentIndex: useViewerStore.getState().currentIndex,
        removeImage: useViewerStore.getState().removeImage,
      }),
    startSlideshow: handleStartSlideshow,
    stopSlideshow,
    toggleSlideshowPause,
    openCommandPalette: () => setShowCommandPalette(true),
    toggleGridView: () => {
      const state = useViewerStore.getState();
      if (state.viewMode === 'viewer') {
        state.setViewMode('grid');
        return;
      }

      void handleExitGridView();
    },
    togglePerformanceTelemetry: handleTogglePerformanceTelemetry,
    toggleFavoriteCurrent: () => {
      const path = useViewerStore.getState().currentImagePath;
      if (path) {
        void toggleFavorite(path);
      }
    },
    toggleMarkedCurrent: () => {
      const path = useViewerStore.getState().currentImagePath;
      if (path) {
        useViewerStore.getState().toggleMarkedPath(path);
      }
    },
    setRatingCurrent: (rating) => {
      const path = useViewerStore.getState().currentImagePath;
      if (path) {
        void setRating(path, rating);
      }
    },
  });

  // Detect if this is a secondary window
  useEffect(() => {
    const label = appWindowRef.current.label;
    setIsSecondary(label === 'secondary');
  }, []);

  // Listen for sync events if we are a secondary window
  useEffect(() => {
    if (!isSecondary) return;

    const unlisten = listen<{ imagePath: string | null; source: 'main' | 'secondary' }>(
      'state-sync',
      (event) => {
        if (event.payload.source !== 'main' || !event.payload.imagePath) {
          return;
        }

        const state = useViewerStore.getState();
        const nextIndex = state.images.findIndex((image) => image.path === event.payload.imagePath);
        if (nextIndex >= 0) {
          state.setCurrentIndex(nextIndex, { zoomMode: 'fit' });
          return;
        }

        void openImage(event.payload.imagePath);
      }
    );
    requestStateSync().catch((err) => console.error('Failed to request projector state:', err));

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isSecondary, openImage]);

  // Keep the main window selection in sync when navigation happens in projector mode.
  useEffect(() => {
    if (!isSecondary || !currentImagePath) return;

    void emitStateSync(currentImagePath, 'secondary').catch((err) =>
      console.error('Failed to sync projector navigation state:', err)
    );
  }, [currentImagePath, isSecondary]);

  // Follow projector navigation updates in the main window without forcing a folder reload.
  useEffect(() => {
    if (isSecondary) return;

    const unlisten = listen<{ imagePath: string | null; source: 'main' | 'secondary' }>(
      'state-sync',
      (event) => {
        if (event.payload.source !== 'secondary') {
          return;
        }

        const nextPath = event.payload.imagePath;
        if (!nextPath || nextPath === useViewerStore.getState().currentImagePath) {
          return;
        }

        const state = useViewerStore.getState();
        const nextIndex = state.images.findIndex((image) => image.path === nextPath);
        if (nextIndex >= 0) {
          state.setCurrentIndex(nextIndex);
          return;
        }

        void openImage(nextPath);
      }
    );

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isSecondary, openImage]);

  // Respond to newly opened secondary windows with the current image
  useEffect(() => {
    if (isSecondary) return;

    const unlisten = listen('state-sync-request', () => {
      if (currentImagePath) {
        emitStateSync(currentImagePath, 'main').catch((err) =>
          console.error('Failed to sync projector state:', err)
        );
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [currentImagePath, isSecondary]);

  // Emit sync events when the image changes in the main window
  useEffect(() => {
    if (isSecondary || !currentImagePath) return;
    void emitStateSync(currentImagePath, 'main').catch((err) =>
      console.error('Failed to sync projector state:', err)
    );
  }, [currentImagePath, isSecondary]);

  const containerClasses = [
    'app-container',
    isFullscreen ? 'fullscreen' : '',
    showControls ? 'controls-visible' : '',
    settings.showThumbnails &&
    currentImagePath &&
    viewMode === 'viewer' &&
    !isSecondary &&
    !isSlideshowActive
      ? 'with-thumbnails'
      : '',
    currentImagePath && viewMode === 'viewer' && !isSecondary && !isSlideshowActive
      ? 'has-viewer-safe-areas'
      : '',
    viewMode === 'grid' && !isSecondary ? 'grid-mode' : '',
    viewMode === 'compare' && !isSecondary ? 'compare-mode' : '',
    isSlideshowActive ? 'slideshow-active' : '',
    isSecondary ? 'secondary-window' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={containerClasses}
      onMouseMove={handleMouseMove}
      onDoubleClick={handleDoubleClick}
    >
      {currentImagePath ? (
        <>
          {isSecondary ? (
            <>
              <ImageCanvas />
              <button
                className="projector-close-btn"
                onClick={() => void handleCloseProjectorWindow()}
                type="button"
                title="Close projector window"
                aria-label="Close projector window"
              >
                x
              </button>
            </>
          ) : viewMode === 'viewer' ? (
            <>
              <ImageCanvas onWheelNext={goNext} onWheelPrev={goPrev} />
              <ViewerChrome
                onOpenFile={openFilePicker}
                onOpenFolder={openFolderPicker}
                onOpenRecentFolder={handleOpenRecentFolder}
                onRefreshFolder={refreshFolder}
                onGoHome={handleGoHome}
                onFirst={goFirst}
                onNext={() => goNext()}
                onPrev={() => goPrev()}
                onStartSlideshow={handleStartSlideshow}
                onStopSlideshow={stopSlideshow}
                onTogglePause={toggleSlideshowPause}
              />
              {settings.showThumbnails && !isSlideshowActive && <ThumbnailStrip />}
            </>
          ) : viewMode === 'compare' ? (
            <>
              <CompareView />
              <ViewerChrome
                onOpenFile={openFilePicker}
                onOpenFolder={openFolderPicker}
                onOpenRecentFolder={handleOpenRecentFolder}
                onRefreshFolder={refreshFolder}
                onGoHome={handleGoHome}
                onFirst={goFirst}
                onNext={() => goNext()}
                onPrev={() => goPrev()}
                onStartSlideshow={handleStartSlideshow}
                onStopSlideshow={stopSlideshow}
                onTogglePause={toggleSlideshowPause}
              />
            </>
          ) : (
            <ContactSheet
              onExitGridView={handleExitGridView}
              onGoHome={handleGoHome}
              onOpenFile={openFilePicker}
              onOpenFolder={openFolderPicker}
              onRefreshFolder={refreshFolder}
              onStartSlideshow={startSlideshow}
            />
          )}
        </>
      ) : (
        <EmptyState
          onOpenFile={openFilePicker}
          onOpenFolder={openFolderPicker}
          onOpenRecentFolder={handleOpenRecentFolder}
        />
      )}

      {showSettings && <SettingsPanel />}
      {showCommandPalette && (
        <CommandPalette
          commands={commandPaletteCommands}
          isOpen={showCommandPalette}
          onClose={() => setShowCommandPalette(false)}
        />
      )}
      {showPerformanceTelemetry && (
        <PerformanceTelemetryOverlay onReset={handleResetPerformanceTelemetry} />
      )}
      <UpdateNotification />
      <ToastViewport />

      {/* Error Banner */}
      {errorMessage && (
        <div className="error-banner" role="alert">
          <span>{errorMessage}</span>
          <button
            onClick={() => {
              goNext();
              setError(null);
            }}
          >
            Try next
          </button>
          <button
            onClick={() => {
              void openFilePicker();
              setError(null);
            }}
          >
            Open file
          </button>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {isDragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <span>📷</span>
            <p>Drop image to open</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

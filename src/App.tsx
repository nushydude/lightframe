import { useEffect, useState, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getMatches } from '@tauri-apps/plugin-cli';
import { ImageCanvas } from './components/ImageCanvas';
import { ViewerChrome } from './components/ViewerChrome';
import { ThumbnailStrip } from './components/ThumbnailStrip';
import { ContactSheet } from './components/ContactSheet';
import { SettingsPanel } from './components/SettingsPanel';
import { EmptyState } from './components/EmptyState';
import { UpdateNotification } from './components/UpdateNotification';
import { useImageNavigation } from './hooks/useImageNavigation';
import { useSlideshow } from './hooks/useSlideshow';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useViewerStore } from './state/viewerStore';
import { useSettingsStore } from './state/settingsStore';

import { emitStateSync, isDirectory, requestStateSync } from './services/tauriCommands';
import { resolveStartupDecision } from './services/startup';

function App() {
  const {
    currentImagePath,
    showSettings,
    errorMessage,
    isFullscreen,
    viewMode,
    setError,
    setShowControls,
    setFullscreen,
    setDefaultZoomMode,
    reset,
  } = useViewerStore();

  const { settings, loadSettings } = useSettingsStore();

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

  const showMainWindowOnce = useCallback(async () => {
    if (startupShowAttemptedRef.current) return;
    startupShowAttemptedRef.current = true;
    setStartupShowAttempted(true);

    try {
      await getCurrentWindow().show();
    } catch (err) {
      console.error('Failed to show main window:', err);
    }
  }, []);

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

  // Keep viewer default zoom mode in sync with settings for newly opened images.
  useEffect(() => {
    setDefaultZoomMode(settings.defaultFitMode);
  }, [settings.defaultFitMode, setDefaultZoomMode]);

  // Handle CLI arguments (default file association) and resolve startup readiness
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isCancelled = false;

    async function init() {
      // Ensure persisted settings are loaded before startup image open.
      await loadSettings();
      if (!isCancelled) {
        const loadedDefaultFitMode = useSettingsStore.getState().settings.defaultFitMode;
        useViewerStore.getState().setDefaultZoomMode(loadedDefaultFitMode);
      }

      try {
        const matches = await getMatches();
        const startupDecision = resolveStartupDecision(matches.args.file);

        if (startupDecision.mode === 'open-image' && startupDecision.filePath) {
          await openImageForStartup(startupDecision.filePath);
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

    // Still listen in case another instance sends a message (future single-instance support)
    listen<string>('open-file', async (event) => {
      await openImage(event.payload);
    }).then((fn) => { unlisten = fn; });

    return () => {
      isCancelled = true;
      if (unlisten) unlisten();
    };
  }, [loadSettings, openImage, openImageForStartup, setError]);

  useEffect(() => {
    if (!hasStartupResolved || startupShowAttempted) return;
    void showMainWindowOnce();
  }, [hasStartupResolved, showMainWindowOnce, startupShowAttempted]);

  // Listen for tauri file drop events
  useEffect(() => {
    const unlistenDrag = listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
      setIsDragOver(false);
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        try {
          const isDir = await isDirectory(paths[0]);
          if (isDir) {
            openFolder(paths[0]);
          } else {
            openImage(paths[0]);
          }
        } catch (err) {
          console.error('Failed to stat dragged file:', err);
          openImage(paths[0]); // fallback
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
      unlistenDrag.then((fn) => fn());
      unlistenDragEnter.then((fn) => fn());
      unlistenDragLeave.then((fn) => fn());
    };
  }, [openImage]);

  // Auto-hide controls in fullscreen
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) {
      clearTimeout(controlsTimerRef.current);
    }
    if (isFullscreen) {
      controlsTimerRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isFullscreen, setShowControls]);

  // Double-click to toggle fullscreen
  const handleDoubleClick = useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.settings-panel') || target.closest('.top-bar') || target.closest('.bottom-controls')) {
      return;
    }
    if (!currentImagePath) return;
    try {
      const appWindow = getCurrentWindow();
      const newFs = !isFullscreen;
      await appWindow.setFullscreen(newFs);
      setFullscreen(newFs);
    } catch (err) {
      console.error('Failed to toggle fullscreen:', err);
    }
  }, [currentImagePath, isFullscreen, setFullscreen]);

  const handleGoHome = useCallback(async () => {
    try {
      if (isFullscreen) {
        await getCurrentWindow().setFullscreen(false);
        setFullscreen(false);
      }
    } catch (err) {
      console.error('Failed to exit fullscreen before returning home:', err);
    } finally {
      reset();
    }
  }, [isFullscreen, reset, setFullscreen]);

  // Register keyboard shortcuts
  useKeyboardShortcuts({
    openFilePicker,
    goNext,
    goPrev,
    goFirst,
    goLast,
    refreshFolder,
    startSlideshow,
    stopSlideshow,
    toggleSlideshowPause,
  });

  const { showControls } = useViewerStore();
  const [isSecondary, setIsSecondary] = useState(false);

  // Detect if this is a secondary window
  useEffect(() => {
    const label = getCurrentWindow().label;
    setIsSecondary(label === 'secondary');
  }, []);

  // Listen for sync events if we are a secondary window
  useEffect(() => {
    if (!isSecondary) return;

    const unlisten = listen<{ imagePath: string | null }>('state-sync', (event) => {
      if (event.payload.imagePath) {
        openImage(event.payload.imagePath);
      }
    });
    requestStateSync().catch((err) => console.error('Failed to request projector state:', err));

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [isSecondary, openImage]);

  // Respond to newly opened secondary windows with the current image
  useEffect(() => {
    if (isSecondary) return;

    const unlisten = listen('state-sync-request', () => {
      if (currentImagePath) {
        emitStateSync(currentImagePath).catch((err) => console.error('Failed to sync projector state:', err));
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [currentImagePath, isSecondary]);

  // Emit sync events when the image changes in the main window
  useEffect(() => {
    if (isSecondary || !currentImagePath) return;
    emitStateSync(currentImagePath).catch((err) => console.error('Failed to sync projector state:', err));
  }, [currentImagePath, isSecondary]);

  const containerClasses = [
    'app-container',
    isFullscreen ? 'fullscreen' : '',
    showControls ? 'controls-visible' : '',
    settings.showThumbnails && currentImagePath && viewMode === 'viewer' && !isSecondary ? 'with-thumbnails' : '',
    viewMode === 'grid' && !isSecondary ? 'grid-mode' : '',
    isSecondary ? 'secondary-window' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={containerClasses}
      onMouseMove={handleMouseMove}
      onDoubleClick={handleDoubleClick}
    >
      {currentImagePath ? (
        <>
          {isSecondary ? (
            <ImageCanvas />
          ) : viewMode === 'viewer' ? (
            <>
              <ImageCanvas onWheelNext={goNext} onWheelPrev={goPrev} />
              <ViewerChrome
                onOpenFile={openFilePicker}
                onOpenFolder={openFolderPicker}
                onRefreshFolder={refreshFolder}
                onGoHome={handleGoHome}
                onNext={() => goNext()}
                onPrev={() => goPrev()}
                onStartSlideshow={startSlideshow}
                onTogglePause={toggleSlideshowPause}
              />
              {settings.showThumbnails && <ThumbnailStrip />}
            </>
          ) : (
            <ContactSheet onGoHome={handleGoHome} />
          )}
        </>
      ) : (
        <EmptyState onOpenFile={openFilePicker} onOpenFolder={openFolderPicker} />
      )}

      {showSettings && <SettingsPanel />}
      <UpdateNotification />

      {/* Error Banner */}
      {errorMessage && (
        <div className="error-banner" role="alert">
          <span>{errorMessage}</span>
          <button onClick={() => { goNext(); setError(null); }}>
            Try next
          </button>
          <button onClick={() => { openFilePicker(); setError(null); }}>
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

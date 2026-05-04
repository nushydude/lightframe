import { useEffect, useState, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ImageCanvas } from './components/ImageCanvas';
import { ViewerChrome } from './components/ViewerChrome';
import { SettingsPanel } from './components/SettingsPanel';
import { EmptyState } from './components/EmptyState';
import { useImageNavigation } from './hooks/useImageNavigation';
import { useSlideshow } from './hooks/useSlideshow';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useViewerStore } from './state/viewerStore';
import { useSettingsStore } from './state/settingsStore';

import { isDirectory } from './services/tauriCommands';

function App() {
  const {
    currentImagePath,
    showSettings,
    errorMessage,
    isFullscreen,
    setError,
    setShowControls,
    setFullscreen,
  } = useViewerStore();

  const { settings, loadSettings } = useSettingsStore();

  const {
    openImage,
    openFolder,
    openFilePicker,
    openFolderPicker,
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
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

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

  // Listen for file open events from CLI/file association
  useEffect(() => {
    const unlisten = listen<string>('open-file', (event) => {
      openImage(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [openImage]);

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

  // Register keyboard shortcuts
  useKeyboardShortcuts({
    openFilePicker,
    goNext,
    goPrev,
    goFirst,
    goLast,
    startSlideshow,
    stopSlideshow,
    toggleSlideshowPause,
  });

  const containerClasses = [
    'app-container',
    isFullscreen ? 'fullscreen' : '',
    useViewerStore.getState().showControls ? 'controls-visible' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={containerClasses}
      onMouseMove={handleMouseMove}
      onDoubleClick={handleDoubleClick}
    >
      {currentImagePath ? (
        <>
          <ImageCanvas />
          <ViewerChrome
            onOpenFile={openFilePicker}
            onOpenFolder={openFolderPicker}
            onNext={() => goNext()}
            onPrev={() => goPrev()}
            onStartSlideshow={startSlideshow}
            onTogglePause={toggleSlideshowPause}
          />
        </>
      ) : (
        <EmptyState onOpenFile={openFilePicker} onOpenFolder={openFolderPicker} />
      )}

      {showSettings && <SettingsPanel />}

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

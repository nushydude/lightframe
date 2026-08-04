import { useCallback, useMemo } from 'react';
import { getRuntime } from '../services/runtime/runtime';
import type { RuntimeWindow } from '../services/runtime/types';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { CurationFilter } from '../services/curationFilter';
import { createViewerCommands, type ViewerCommand } from '../services/commandRegistry';
import { closeSecondaryWindow, openSecondaryWindow } from '../services/tauriCommands';
import {
  resetPerformanceTelemetry,
  setPerformanceTelemetryEnabled,
} from '../services/performanceTelemetry';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import {
  openCurrentImageInEditor,
  copyCurrentImage,
  copyCurrentImagePath,
  deleteCurrentImage,
  revealCurrentImage,
} from '../services/viewerActions';

type AppViewerActionsOptions = {
  appWindow: RuntimeWindow;
  currentImagePath: string | null;
  isFullscreen: boolean;
  isSecondary: boolean;
  isProjectorOpen: boolean;
  openFolder: (folderPath: string, options?: { curationFilter?: CurationFilter }) => Promise<void>;
  openFilePicker: () => Promise<void>;
  openFolderPicker: () => Promise<void>;
  goNext: () => boolean;
  goPrev: () => boolean;
  goFirst: () => void;
  goLast: () => void;
  refreshProjectorState: () => Promise<void>;
  startSlideshow: () => Promise<void>;
  setFullscreen: (value: boolean) => void;
  setShowPerformanceTelemetry: (value: boolean) => void;
  reset: () => void;
};

async function toggleFullscreen(appWindow: RuntimeWindow, setFullscreen: (value: boolean) => void) {
  const nextFullscreen = !useViewerStore.getState().isFullscreen;
  try {
    await appWindow.setFullscreen(nextFullscreen);
    setFullscreen(nextFullscreen);
  } catch (error) {
    console.error('Failed to toggle fullscreen:', error);
  }
}

async function exitGridView(
  isProjectorOpen: boolean,
  refreshProjectorState: () => Promise<unknown>
) {
  if (!isProjectorOpen) {
    useViewerStore.getState().setViewMode('viewer');
    return true;
  }

  const confirmed = await getRuntime().confirm(
    'Leaving grid view will close projector mode. Continue?',
    { title: 'Projector mode', kind: 'warning' }
  );
  if (!confirmed) return false;

  await closeSecondaryWindow();
  await refreshProjectorState();
  useViewerStore.getState().setViewMode('viewer');
  return true;
}

function createCommandPaletteCommands(options: {
  openFilePicker: () => Promise<unknown>;
  openFolderPicker: () => Promise<unknown>;
  goNext: () => boolean;
  goPrev: () => boolean;
  goFirst: () => void;
  goLast: () => void;
  toggleFullscreen: () => Promise<void>;
  toggleProjector: () => Promise<void>;
  togglePerformanceTelemetry: () => void;
  resetPerformanceTelemetry: () => void;
  startSlideshow: () => Promise<void>;
}): ViewerCommand[] {
  return createViewerCommands({
    ...options,
    saveRotation: () => useViewerStore.getState().saveRotation(),
    revealCurrentImage: () => revealCurrentImage(useViewerStore.getState().currentImagePath),
    openCurrentImageInEditor: () =>
      openCurrentImageInEditor(useViewerStore.getState().currentImagePath),
    copyCurrentImage: () => copyCurrentImage(useViewerStore.getState().currentImagePath),
    copyCurrentImagePath: () => copyCurrentImagePath(useViewerStore.getState().currentImagePath),
    deleteCurrentImage: () =>
      deleteCurrentImage({
        currentImagePath: useViewerStore.getState().currentImagePath,
        currentIndex: useViewerStore.getState().currentIndex,
        removeImage: useViewerStore.getState().removeImage,
      }),
    enterCropMode: () => {
      const state = useViewerStore.getState();
      if (state.viewMode === 'grid') state.setViewMode('viewer');
      state.enterCropMode();
    },
    toggleCompareMode: () => {
      const state = useViewerStore.getState();
      if (state.viewMode === 'compare') state.exitCompareMode();
      else state.enterCompareMode();
    },
    toggleMarkedCurrent: () => {
      const path = useViewerStore.getState().currentImagePath;
      if (path) useViewerStore.getState().toggleMarkedPath(path);
    },
  });
}

/** Owns App callbacks that coordinate viewer/projector/slideshow commands. */
export function useAppViewerActions({
  appWindow,
  currentImagePath,
  isFullscreen,
  isSecondary,
  isProjectorOpen,
  openFolder,
  openFilePicker,
  openFolderPicker,
  goNext,
  goPrev,
  goFirst,
  goLast,
  refreshProjectorState,
  startSlideshow,
  setFullscreen,
  setShowPerformanceTelemetry,
  reset,
}: AppViewerActionsOptions) {
  const handleDoubleClick = useCallback(
    async (event: ReactMouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest('button, .settings-panel, .top-bar, .bottom-controls') ||
        !currentImagePath
      )
        return;
      try {
        await appWindow.setFullscreen(!isFullscreen);
        setFullscreen(!isFullscreen);
      } catch (error) {
        console.error('Failed to toggle fullscreen:', error);
      }
    },
    [appWindow, currentImagePath, isFullscreen, setFullscreen]
  );

  const handleGoHome = useCallback(async () => {
    try {
      if (isFullscreen) {
        await appWindow.setFullscreen(false);
        setFullscreen(false);
      }
    } catch (error) {
      console.error('Failed to exit fullscreen before returning home:', error);
    } finally {
      reset();
    }
  }, [appWindow, isFullscreen, reset, setFullscreen]);

  const handleOpenRecentFolder = useCallback(
    async (folderPath: string, filter: CurationFilter = 'all') => {
      await openFolder(folderPath, { curationFilter: filter });
    },
    [openFolder]
  );

  const handleToggleFullscreen = useCallback(
    () => toggleFullscreen(appWindow, setFullscreen),
    [appWindow, setFullscreen]
  );

  const handleTogglePerformanceTelemetry = useCallback(() => {
    const nextValue = !useViewerStore.getState().showPerformanceTelemetry;
    setPerformanceTelemetryEnabled(nextValue);
    setShowPerformanceTelemetry(nextValue);
  }, [setShowPerformanceTelemetry]);

  const handleResetPerformanceTelemetry = useCallback(() => resetPerformanceTelemetry(), []);

  const handleToggleProjector = useCallback(async () => {
    const state = useViewerStore.getState();
    if (state.currentImagePath === null || isSecondary) return;

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
    } catch (error) {
      console.error('Failed to close projector window:', error);
    }
  }, [refreshProjectorState]);

  const handleExitGridView = useCallback(
    () => exitGridView(isProjectorOpen, refreshProjectorState),
    [isProjectorOpen, refreshProjectorState]
  );

  const handleStartSlideshow = useCallback(async () => {
    const state = useViewerStore.getState();
    if (state.viewMode === 'grid' && !(await handleExitGridView())) return;
    if (state.viewMode !== 'viewer') state.setViewMode('viewer');
    await startSlideshow();
  }, [handleExitGridView, startSlideshow]);

  const commandPaletteCommands = useMemo(
    () =>
      createCommandPaletteCommands({
        openFilePicker,
        openFolderPicker,
        goNext,
        goPrev,
        goFirst,
        goLast,
        toggleFullscreen: handleToggleFullscreen,
        toggleProjector: handleToggleProjector,
        togglePerformanceTelemetry: handleTogglePerformanceTelemetry,
        resetPerformanceTelemetry: handleResetPerformanceTelemetry,
        startSlideshow: handleStartSlideshow,
      }),
    [
      goFirst,
      goLast,
      goNext,
      goPrev,
      handleResetPerformanceTelemetry,
      handleStartSlideshow,
      handleToggleFullscreen,
      handleTogglePerformanceTelemetry,
      handleToggleProjector,
      openFilePicker,
      openFolderPicker,
    ]
  );

  return {
    handleDoubleClick,
    handleGoHome,
    handleOpenRecentFolder,
    handleToggleFullscreen,
    handleTogglePerformanceTelemetry,
    handleResetPerformanceTelemetry,
    handleToggleProjector,
    handleCloseProjectorWindow,
    handleExitGridView,
    handleStartSlideshow,
    commandPaletteCommands,
  };
}

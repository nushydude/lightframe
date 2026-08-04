import { useShallow } from 'zustand/react/shallow';
import { AppViewerSurface } from './components/AppViewerSurface';
import { AppOverlays } from './components/AppOverlays';
import { useAppRuntimeLifecycle } from './hooks/useAppRuntimeLifecycle';
import { useViewerStore } from './state/viewerStore';
import { useSettingsStore } from './state/settingsStore';
import { CurationPersistenceError, useCurationStore } from './state/curationStore';
import { getAppContainerClasses } from './services/appContainerClasses';

function activeCurationHydrationPaths(): string[] | undefined {
  const state = useViewerStore.getState();
  const images = state.allImages.length > 0 ? state.allImages : state.images;
  const paths = images.map((image) => image.path);
  return paths.length > 0 ? paths : undefined;
}

async function retryCurationPersistence({
  mutationError,
  retryMutation,
  loadCuration,
}: {
  mutationError: string | null;
  retryMutation: () => Promise<void>;
  loadCuration: () => Promise<void>;
}) {
  const retry = mutationError ? retryMutation() : loadCuration();
  try {
    await retry;
  } catch (error: unknown) {
    if (!(error instanceof CurationPersistenceError)) {
      console.error('Unexpected curation retry failure:', error);
    }
  }
}

function App() {
  return <AppRuntime />;
}

function AppRuntime() {
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
    showControls,
    setError,
    setShowControls,
    setShowCommandPalette,
    setShowPerformanceTelemetry,
    setFullscreen,
    setDefaultZoomMode,
    resetZoom,
    syncFavoriteFilter,
    reset,
  } = useViewerStore(
    useShallow((state) => ({
      currentImagePath: state.currentImagePath,
      markedPaths: state.markedPaths,
      folderPath: state.folderPath,
      showSettings: state.showSettings,
      showCommandPalette: state.showCommandPalette,
      showPerformanceTelemetry: state.showPerformanceTelemetry,
      errorMessage: state.errorMessage,
      isFullscreen: state.isFullscreen,
      isSlideshowActive: state.isSlideshowActive,
      viewMode: state.viewMode,
      showControls: state.showControls,
      setError: state.setError,
      setShowControls: state.setShowControls,
      setShowCommandPalette: state.setShowCommandPalette,
      setShowPerformanceTelemetry: state.setShowPerformanceTelemetry,
      setFullscreen: state.setFullscreen,
      setDefaultZoomMode: state.setDefaultZoomMode,
      resetZoom: state.resetZoom,
      syncFavoriteFilter: state.syncFavoriteFilter,
      reset: state.reset,
    }))
  );

  const {
    theme,
    recentFolders,
    performanceMode,
    defaultFitMode,
    showThumbnails,
    isLoaded,
    loadSettings,
    updateSettings,
  } = useSettingsStore(
    useShallow((state) => ({
      theme: state.settings.theme,
      recentFolders: state.settings.recentFolders,
      performanceMode: state.settings.performanceMode,
      defaultFitMode: state.settings.defaultFitMode,
      showThumbnails: state.settings.showThumbnails,
      isLoaded: state.isLoaded,
      loadSettings: state.loadSettings,
      updateSettings: state.updateSettings,
    }))
  );

  const {
    loadCuration,
    toggleFavorite,
    setRating,
    curationByPath,
    favoriteCurationPaths,
    curationLoadError,
    curationMutationError,
    curationErrorDismissed,
    retryLastFailedCuration,
    dismissCurationError,
  } = useCurationStore(
    useShallow((state) => ({
      loadCuration: state.loadCuration,
      toggleFavorite: state.toggleFavorite,
      setRating: state.setRating,
      curationByPath: state.curationByPath,
      favoriteCurationPaths: state.favoritePaths,
      curationLoadError: state.loadError,
      curationMutationError: state.mutationError,
      curationErrorDismissed: state.errorDismissed,
      retryLastFailedCuration: state.retryLastFailedOperation,
      dismissCurationError: state.dismissError,
    }))
  );

  const {
    handleDoubleClick,
    handleGoHome,
    handleOpenRecentFolder,
    handleResetPerformanceTelemetry,
    handleCloseProjectorWindow,
    handleExitGridView,
    handleStartSlideshow,
    commandPaletteCommands,
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
  } = useAppRuntimeLifecycle({
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
  });

  const containerClasses = getAppContainerClasses({
    isFullscreen,
    showControls,
    showThumbnails,
    currentImagePath,
    viewMode,
    isSecondary,
    isSlideshowActive,
  });

  return (
    <div
      className={containerClasses}
      data-testid="native-app-root"
      data-runtime-ready={isLoaded ? 'true' : 'false'}
      onMouseMove={handleMouseMove}
      onDoubleClick={handleDoubleClick}
    >
      <AppViewerSurface
        currentImagePath={currentImagePath}
        isSecondary={isSecondary}
        viewMode={viewMode}
        showThumbnails={showThumbnails}
        isSlideshowActive={isSlideshowActive}
        onCloseProjectorWindow={handleCloseProjectorWindow}
        onNext={() => goNext()}
        onPrev={() => goPrev()}
        onOpenFile={openFilePicker}
        onOpenFolder={openFolderPicker}
        onOpenRecentFolder={handleOpenRecentFolder}
        onRefreshFolder={refreshFolder}
        onGoHome={handleGoHome}
        onFirst={goFirst}
        onLast={goLast}
        onStartSlideshow={handleStartSlideshow}
        onStopSlideshow={stopSlideshow}
        onTogglePause={toggleSlideshowPause}
        onExitGridView={handleExitGridView}
      />

      <AppOverlays
        showSettings={showSettings}
        showCommandPalette={showCommandPalette}
        commandPaletteCommands={commandPaletteCommands}
        onCloseCommandPalette={() => setShowCommandPalette(false)}
        showPerformanceTelemetry={showPerformanceTelemetry}
        onResetPerformanceTelemetry={handleResetPerformanceTelemetry}
        curationError={curationMutationError ?? curationLoadError}
        curationErrorDismissed={curationErrorDismissed}
        onRetryCuration={() =>
          retryCurationPersistence({
            mutationError: curationMutationError,
            retryMutation: retryLastFailedCuration,
            loadCuration: () => loadCuration(activeCurationHydrationPaths()),
          })
        }
        onDismissCurationError={dismissCurationError}
        errorMessage={errorMessage}
        onTryNext={() => {
          goNext();
          setError(null);
        }}
        onOpenFile={() => {
          void openFilePicker();
          setError(null);
        }}
        onClearError={() => setError(null)}
        isDragOver={isDragOver}
      />
    </div>
  );
}

export default App;

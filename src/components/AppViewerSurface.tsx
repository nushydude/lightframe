import { EmptyState } from './EmptyState';
import { ImageCanvas } from './ImageCanvas';
import { LazySurface } from './LazySurface';
import { ThumbnailStrip } from './ThumbnailStrip';
import { ViewerChrome } from './ViewerChrome';
import type { CurationFilter } from '../services/curationFilter';

const loadContactSheet = () =>
  import('./ContactSheet').then(({ ContactSheet }) => ({ default: ContactSheet }));
const loadCompareView = () =>
  import('./CompareView').then(({ CompareView }) => ({ default: CompareView }));

interface AppViewerSurfaceProps {
  currentImagePath: string | null;
  isSecondary: boolean;
  viewMode: 'viewer' | 'grid' | 'compare';
  showThumbnails: boolean;
  isSlideshowActive: boolean;
  onCloseProjectorWindow: () => void | Promise<void>;
  onNext: () => void;
  onPrev: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecentFolder: (folderPath: string, filter?: CurationFilter) => void | Promise<void>;
  onRefreshFolder: () => void;
  onGoHome: () => void | Promise<void>;
  onFirst: () => void;
  onLast: () => void;
  onStartSlideshow: () => void | Promise<void>;
  onStopSlideshow: () => void | Promise<void>;
  onTogglePause: () => void;
  onExitGridView: () => Promise<boolean>;
}

export function AppViewerSurface(props: AppViewerSurfaceProps) {
  if (!props.currentImagePath) {
    return (
      <EmptyState
        onOpenFile={props.onOpenFile}
        onOpenFolder={props.onOpenFolder}
        onOpenRecentFolder={props.onOpenRecentFolder}
      />
    );
  }
  return <AppViewerModes {...props} />;
}

function AppViewerModes({
  isSecondary,
  viewMode,
  showThumbnails,
  isSlideshowActive,
  onCloseProjectorWindow,
  onNext,
  onPrev,
  onOpenFile,
  onOpenFolder,
  onOpenRecentFolder,
  onRefreshFolder,
  onGoHome,
  onFirst,
  onLast,
  onStartSlideshow,
  onStopSlideshow,
  onTogglePause,
  onExitGridView,
}: AppViewerSurfaceProps) {
  if (isSecondary) {
    return <SecondaryViewer onCloseProjectorWindow={onCloseProjectorWindow} />;
  }

  return (
    <AppViewerModeContent
      viewMode={viewMode}
      showThumbnails={showThumbnails}
      isSlideshowActive={isSlideshowActive}
      onNext={onNext}
      onPrev={onPrev}
      onOpenFile={onOpenFile}
      onOpenFolder={onOpenFolder}
      onOpenRecentFolder={onOpenRecentFolder}
      onRefreshFolder={onRefreshFolder}
      onGoHome={onGoHome}
      onFirst={onFirst}
      onLast={onLast}
      onStartSlideshow={onStartSlideshow}
      onStopSlideshow={onStopSlideshow}
      onTogglePause={onTogglePause}
      onExitGridView={onExitGridView}
    />
  );
}

function AppViewerModeContent({
  viewMode,
  showThumbnails,
  isSlideshowActive,
  onNext,
  onPrev,
  onOpenFile,
  onOpenFolder,
  onOpenRecentFolder,
  onRefreshFolder,
  onGoHome,
  onFirst,
  onLast,
  onStartSlideshow,
  onStopSlideshow,
  onTogglePause,
  onExitGridView,
}: Omit<AppViewerSurfaceProps, 'currentImagePath' | 'isSecondary' | 'onCloseProjectorWindow'>) {
  if (viewMode === 'viewer') {
    return (
      <ViewerMode
        {...{
          onNext,
          onPrev,
          onOpenFile,
          onOpenFolder,
          onOpenRecentFolder,
          onRefreshFolder,
          onGoHome,
          onFirst,
          onLast,
          onStartSlideshow,
          onStopSlideshow,
          onTogglePause,
          showThumbnails,
          isSlideshowActive,
        }}
      />
    );
  }

  if (viewMode === 'compare') {
    return (
      <CompareMode
        {...{
          onNext,
          onPrev,
          onOpenFile,
          onOpenFolder,
          onOpenRecentFolder,
          onRefreshFolder,
          onGoHome,
          onFirst,
          onLast,
          onStartSlideshow,
          onStopSlideshow,
          onTogglePause,
        }}
      />
    );
  }

  return (
    <ContactSheetMode
      {...{ onExitGridView, onGoHome, onOpenFile, onOpenFolder, onRefreshFolder, onStartSlideshow }}
    />
  );
}

function SecondaryViewer({
  onCloseProjectorWindow,
}: Pick<AppViewerSurfaceProps, 'onCloseProjectorWindow'>) {
  return (
    <>
      <ImageCanvas />
      <button
        className="projector-close-btn"
        onClick={onCloseProjectorWindow}
        type="button"
        title="Close projector window"
        aria-label="Close projector window"
      >
        x
      </button>
    </>
  );
}

type ViewerModeProps = Omit<
  AppViewerSurfaceProps,
  'currentImagePath' | 'isSecondary' | 'viewMode' | 'onCloseProjectorWindow' | 'onExitGridView'
>;

function ViewerChromeForMode(
  props: Pick<
    ViewerModeProps,
    | 'onOpenFile'
    | 'onOpenFolder'
    | 'onOpenRecentFolder'
    | 'onRefreshFolder'
    | 'onGoHome'
    | 'onFirst'
    | 'onLast'
    | 'onNext'
    | 'onPrev'
    | 'onStartSlideshow'
    | 'onStopSlideshow'
    | 'onTogglePause'
  >
) {
  return <ViewerChrome {...props} />;
}

function ViewerMode(
  props: Pick<
    ViewerModeProps,
    | 'onNext'
    | 'onPrev'
    | 'onOpenFile'
    | 'onOpenFolder'
    | 'onOpenRecentFolder'
    | 'onRefreshFolder'
    | 'onGoHome'
    | 'onFirst'
    | 'onLast'
    | 'onStartSlideshow'
    | 'onStopSlideshow'
    | 'onTogglePause'
    | 'showThumbnails'
    | 'isSlideshowActive'
  >
) {
  return (
    <>
      <ImageCanvas onWheelNext={props.onNext} onWheelPrev={props.onPrev} />
      <ViewerChromeForMode {...props} />
      {props.showThumbnails && !props.isSlideshowActive && <ThumbnailStrip />}
    </>
  );
}

function CompareMode(
  props: Pick<
    ViewerModeProps,
    | 'onNext'
    | 'onPrev'
    | 'onOpenFile'
    | 'onOpenFolder'
    | 'onOpenRecentFolder'
    | 'onRefreshFolder'
    | 'onGoHome'
    | 'onFirst'
    | 'onLast'
    | 'onStartSlideshow'
    | 'onStopSlideshow'
    | 'onTogglePause'
  >
) {
  return (
    <>
      <LazySurface label="Compare view" loader={loadCompareView} props={{}} />
      <ViewerChromeForMode {...props} />
    </>
  );
}

function ContactSheetMode({
  onExitGridView,
  onGoHome,
  onOpenFile,
  onOpenFolder,
  onRefreshFolder,
  onStartSlideshow,
}: Pick<
  AppViewerSurfaceProps,
  | 'onExitGridView'
  | 'onGoHome'
  | 'onOpenFile'
  | 'onOpenFolder'
  | 'onRefreshFolder'
  | 'onStartSlideshow'
>) {
  return (
    <LazySurface
      label="Contact sheet"
      loader={loadContactSheet}
      props={{
        onExitGridView,
        onGoHome,
        onOpenFile,
        onOpenFolder,
        onRefreshFolder,
        onStartSlideshow,
      }}
    />
  );
}

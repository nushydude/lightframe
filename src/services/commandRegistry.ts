import { useViewerStore } from '../state/viewerStore';
import { canSaveRotationForPath } from './viewerActions';
import { CURATION_FILTER_OPTIONS } from './curationFilter';

type ViewerState = ReturnType<typeof useViewerStore.getState>;

export interface ViewerCommand {
  id: string;
  label: string;
  keywords?: string[];
  shortcut?: string;
  isEnabled: (state: ViewerState) => boolean;
  run: () => void | Promise<void>;
}

interface CreateViewerCommandsOptions {
  openFilePicker: () => void;
  openFolderPicker: () => void;
  goNext: () => void;
  goPrev: () => void;
  goFirst: () => void;
  goLast: () => void;
  toggleFullscreen: () => Promise<void>;
  saveRotation: () => Promise<void>;
  revealCurrentImage: () => Promise<void>;
  openCurrentImageInEditor: () => Promise<void>;
  copyCurrentImage: () => Promise<void>;
  copyCurrentImagePath: () => Promise<void>;
  deleteCurrentImage: () => Promise<void>;
  toggleProjector: () => Promise<void>;
  enterCropMode: () => void;
  startSlideshow: () => void;
  toggleCompareMode: () => void;
  toggleMarkedCurrent: () => void;
  togglePerformanceTelemetry: () => void;
  resetPerformanceTelemetry: () => void;
}

export function createViewerCommands(options: CreateViewerCommandsOptions): ViewerCommand[] {
  return [
    {
      id: 'open-file',
      label: 'Open File',
      keywords: ['file', 'open'],
      shortcut: 'Ctrl+O',
      isEnabled: () => true,
      run: () => options.openFilePicker(),
    },
    {
      id: 'open-folder',
      label: 'Open Folder',
      keywords: ['folder', 'directory', 'open'],
      isEnabled: () => true,
      run: () => options.openFolderPicker(),
    },
    {
      id: 'next-image',
      label: 'Next Image',
      keywords: ['next', 'forward'],
      shortcut: 'Right',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.goNext(),
    },
    {
      id: 'previous-image',
      label: 'Previous Image',
      keywords: ['previous', 'back'],
      shortcut: 'Left',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.goPrev(),
    },
    {
      id: 'first-image',
      label: 'First Image',
      keywords: ['first', 'home'],
      shortcut: 'Home',
      isEnabled: (state) => state.images.length > 0,
      run: () => options.goFirst(),
    },
    {
      id: 'last-image',
      label: 'Last Image',
      keywords: ['last', 'end'],
      shortcut: 'End',
      isEnabled: (state) => state.images.length > 0,
      run: () => options.goLast(),
    },
    {
      id: 'toggle-fullscreen',
      label: 'Toggle Fullscreen',
      keywords: ['fullscreen', 'window'],
      shortcut: 'F11',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.toggleFullscreen(),
    },
    {
      id: 'fit-to-screen',
      label: 'Fit to Screen',
      keywords: ['fit', 'zoom'],
      shortcut: '0',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => useViewerStore.getState().setZoomMode('fit'),
    },
    {
      id: 'actual-size',
      label: 'Actual Size',
      keywords: ['actual', '100%', 'zoom'],
      shortcut: '1',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => useViewerStore.getState().setZoomMode('actual'),
    },
    {
      id: 'zoom-in',
      label: 'Zoom In',
      keywords: ['zoom', 'plus'],
      shortcut: '+',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => useViewerStore.getState().zoomIn(),
    },
    {
      id: 'zoom-out',
      label: 'Zoom Out',
      keywords: ['zoom', 'minus'],
      shortcut: '-',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => useViewerStore.getState().zoomOut(),
    },
    {
      id: 'rotate-left',
      label: 'Rotate Left',
      keywords: ['rotate', 'counterclockwise', 'left'],
      shortcut: 'L',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => useViewerStore.getState().rotateCounterClockwise(),
    },
    {
      id: 'rotate-right',
      label: 'Rotate Right',
      keywords: ['rotate', 'clockwise', 'right'],
      shortcut: 'R',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => useViewerStore.getState().rotateClockwise(),
    },
    {
      id: 'save-rotation',
      label: 'Save Rotation',
      keywords: ['rotate', 'save'],
      isEnabled: (state) => state.rotation !== 0 && canSaveRotationForPath(state.currentImagePath),
      run: () => options.saveRotation(),
    },
    {
      id: 'toggle-grid',
      label: 'Toggle Grid',
      keywords: ['grid', 'contact sheet'],
      shortcut: 'G',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => {
        const state = useViewerStore.getState();
        state.setViewMode(state.viewMode === 'viewer' ? 'grid' : 'viewer');
      },
    },
    ...CURATION_FILTER_OPTIONS.map((filter) => ({
      id: `curation-filter-${filter.value}`,
      label: filter.value === 'all' ? 'Show All Images' : `Show ${filter.label}`,
      keywords: ['filter', 'curation', 'review', filter.label.toLowerCase()],
      isEnabled: (state: ViewerState) => state.allImages.length > 0 || state.images.length > 0,
      run: () => useViewerStore.getState().setCurationFilter(filter.value),
    })),
    {
      id: 'toggle-compare',
      label: 'Toggle Compare View',
      keywords: ['compare', 'side-by-side', 'review'],
      isEnabled: (state) => state.images.length > 1 && Boolean(state.currentImagePath),
      run: () => options.toggleCompareMode(),
    },
    {
      id: 'toggle-settings',
      label: 'Toggle Settings',
      keywords: ['settings', 'preferences'],
      shortcut: 'Ctrl+,',
      isEnabled: () => true,
      run: () => {
        const state = useViewerStore.getState();
        state.setShowSettings(!state.showSettings);
      },
    },
    {
      id: 'reveal-in-folder',
      label: 'Reveal in Folder',
      keywords: ['reveal', 'explorer', 'finder'],
      shortcut: 'Ctrl+Shift+O',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.revealCurrentImage(),
    },
    {
      id: 'open-in-editor',
      label: 'Open in External Editor',
      keywords: ['edit', 'external', 'editor', 'paint', 'retouch'],
      shortcut: 'Ctrl+E',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.openCurrentImageInEditor(),
    },
    {
      id: 'copy-to-clipboard',
      label: 'Copy to Clipboard',
      keywords: ['copy', 'clipboard'],
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.copyCurrentImage(),
    },
    {
      id: 'copy-image-path',
      label: 'Copy Image Path',
      keywords: ['copy', 'path', 'clipboard', 'file'],
      shortcut: 'Ctrl+Shift+C',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.copyCurrentImagePath(),
    },
    {
      id: 'delete-image',
      label: 'Delete Image',
      keywords: ['delete', 'trash', 'recycle'],
      shortcut: 'Delete',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.deleteCurrentImage(),
    },
    {
      id: 'toggle-projector',
      label: 'Toggle Projector Mode',
      keywords: ['projector', 'secondary', 'display', 'presentation'],
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.toggleProjector(),
    },
    {
      id: 'crop-image',
      label: 'Crop Image',
      keywords: ['crop', 'edit', 'trim'],
      isEnabled: (state) =>
        Boolean(state.currentImagePath) && state.rotation === 0 && state.viewMode !== 'compare',
      run: () => options.enterCropMode(),
    },
    {
      id: 'start-slideshow',
      label: 'Start Slideshow',
      keywords: ['slideshow', 'presentation', 'play'],
      shortcut: 'F5',
      isEnabled: (state) => Boolean(state.currentImagePath) && !state.isSlideshowActive,
      run: () => options.startSlideshow(),
    },
    {
      id: 'toggle-mark-current',
      label: 'Mark Current Image',
      keywords: ['mark', 'select', 'bulk', 'batch'],
      shortcut: 'M',
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.toggleMarkedCurrent(),
    },
    {
      id: 'toggle-performance-telemetry',
      label: 'Toggle Performance Telemetry',
      keywords: ['performance', 'telemetry', 'overlay', 'profiling'],
      shortcut: 'Ctrl+Shift+F12',
      isEnabled: () => true,
      run: () => options.togglePerformanceTelemetry(),
    },
    {
      id: 'reset-performance-telemetry',
      label: 'Reset Performance Telemetry',
      keywords: ['performance', 'telemetry', 'reset', 'overlay'],
      isEnabled: () => true,
      run: () => options.resetPerformanceTelemetry(),
    },
  ];
}

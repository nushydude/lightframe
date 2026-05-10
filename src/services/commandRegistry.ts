import { useViewerStore } from '../state/viewerStore';
import { canSaveRotationForPath } from './viewerActions';

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
  copyCurrentImage: () => Promise<void>;
  deleteCurrentImage: () => Promise<void>;
  startSlideshow: () => void;
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
      isEnabled: (state) =>
        state.rotation !== 0 && canSaveRotationForPath(state.currentImagePath),
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
      id: 'copy-to-clipboard',
      label: 'Copy to Clipboard',
      keywords: ['copy', 'clipboard'],
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.copyCurrentImage(),
    },
    {
      id: 'delete-image',
      label: 'Delete Image',
      keywords: ['delete', 'trash', 'recycle'],
      isEnabled: (state) => Boolean(state.currentImagePath),
      run: () => options.deleteCurrentImage(),
    },
    {
      id: 'start-slideshow',
      label: 'Start Slideshow',
      keywords: ['slideshow', 'presentation', 'play'],
      shortcut: 'F5',
      isEnabled: (state) => Boolean(state.currentImagePath) && !state.isSlideshowActive,
      run: () => options.startSlideshow(),
    },
  ];
}

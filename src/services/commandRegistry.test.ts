import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createViewerCommands } from './commandRegistry';
import { useViewerStore } from '../state/viewerStore';

describe('createViewerCommands', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
  });

  it('executes file actions directly in grid mode', async () => {
    const saveRotation = vi.fn().mockResolvedValue(undefined);
    const revealCurrentImage = vi.fn().mockResolvedValue(undefined);
    const openCurrentImageInEditor = vi.fn().mockResolvedValue(undefined);
    const copyCurrentImage = vi.fn().mockResolvedValue(undefined);
    const deleteCurrentImage = vi.fn().mockResolvedValue(undefined);
    const toggleProjector = vi.fn().mockResolvedValue(undefined);

    useViewerStore.setState({
      currentImagePath: 'c:/images/test.jpg',
      currentIndex: 0,
      rotation: 90,
      viewMode: 'grid',
    });

    const commands = createViewerCommands({
      openFilePicker: vi.fn(),
      openFolderPicker: vi.fn(),
      goNext: vi.fn(),
      goPrev: vi.fn(),
      goFirst: vi.fn(),
      goLast: vi.fn(),
      toggleFullscreen: vi.fn().mockResolvedValue(undefined),
      saveRotation,
      revealCurrentImage,
      openCurrentImageInEditor,
      copyCurrentImage,
      copyCurrentImagePath: vi.fn().mockResolvedValue(undefined),
      deleteCurrentImage,
      toggleProjector,
      enterCropMode: vi.fn(),
      startSlideshow: vi.fn(),
      toggleCompareMode: vi.fn(),
      togglePerformanceTelemetry: vi.fn(),
      resetPerformanceTelemetry: vi.fn(),
    });

    const state = useViewerStore.getState();
    const saveRotationCommand = commands.find((command) => command.id === 'save-rotation');
    const revealCommand = commands.find((command) => command.id === 'reveal-in-folder');
    const editCommand = commands.find((command) => command.id === 'open-in-editor');
    const copyCommand = commands.find((command) => command.id === 'copy-to-clipboard');
    const deleteCommand = commands.find((command) => command.id === 'delete-image');

    expect(saveRotationCommand?.isEnabled(state)).toBe(true);
    expect(revealCommand?.isEnabled(state)).toBe(true);
    expect(editCommand?.isEnabled(state)).toBe(true);
    expect(copyCommand?.isEnabled(state)).toBe(true);
    expect(deleteCommand?.isEnabled(state)).toBe(true);

    await saveRotationCommand?.run();
    await revealCommand?.run();
    await editCommand?.run();
    await copyCommand?.run();
    await deleteCommand?.run();

    expect(saveRotation).toHaveBeenCalledTimes(1);
    expect(revealCurrentImage).toHaveBeenCalledTimes(1);
    expect(openCurrentImageInEditor).toHaveBeenCalledTimes(1);
    expect(copyCurrentImage).toHaveBeenCalledTimes(1);
    expect(deleteCurrentImage).toHaveBeenCalledTimes(1);
  });

  it('includes a crop command when rotation preview is clear', () => {
    const enterCropMode = vi.fn();

    useViewerStore.setState({
      currentImagePath: 'c:/images/test.jpg',
      rotation: 0,
    });

    const commands = createViewerCommands({
      openFilePicker: vi.fn(),
      openFolderPicker: vi.fn(),
      goNext: vi.fn(),
      goPrev: vi.fn(),
      goFirst: vi.fn(),
      goLast: vi.fn(),
      toggleFullscreen: vi.fn().mockResolvedValue(undefined),
      saveRotation: vi.fn().mockResolvedValue(undefined),
      revealCurrentImage: vi.fn().mockResolvedValue(undefined),
      openCurrentImageInEditor: vi.fn().mockResolvedValue(undefined),
      copyCurrentImage: vi.fn().mockResolvedValue(undefined),
      copyCurrentImagePath: vi.fn().mockResolvedValue(undefined),
      deleteCurrentImage: vi.fn().mockResolvedValue(undefined),
      toggleProjector: vi.fn().mockResolvedValue(undefined),
      enterCropMode,
      startSlideshow: vi.fn(),
      toggleCompareMode: vi.fn(),
      togglePerformanceTelemetry: vi.fn(),
      resetPerformanceTelemetry: vi.fn(),
    });

    const cropCommand = commands.find((command) => command.id === 'crop-image');
    expect(cropCommand?.isEnabled(useViewerStore.getState())).toBe(true);
    void cropCommand?.run();
    expect(enterCropMode).toHaveBeenCalledTimes(1);
  });

  it('disables the crop command while compare mode is active', () => {
    useViewerStore.setState({
      currentImagePath: 'c:/images/test.jpg',
      rotation: 0,
      viewMode: 'compare',
    });

    const commands = createViewerCommands({
      openFilePicker: vi.fn(),
      openFolderPicker: vi.fn(),
      goNext: vi.fn(),
      goPrev: vi.fn(),
      goFirst: vi.fn(),
      goLast: vi.fn(),
      toggleFullscreen: vi.fn().mockResolvedValue(undefined),
      saveRotation: vi.fn().mockResolvedValue(undefined),
      revealCurrentImage: vi.fn().mockResolvedValue(undefined),
      openCurrentImageInEditor: vi.fn().mockResolvedValue(undefined),
      copyCurrentImage: vi.fn().mockResolvedValue(undefined),
      copyCurrentImagePath: vi.fn().mockResolvedValue(undefined),
      deleteCurrentImage: vi.fn().mockResolvedValue(undefined),
      toggleProjector: vi.fn().mockResolvedValue(undefined),
      enterCropMode: vi.fn(),
      startSlideshow: vi.fn(),
      toggleCompareMode: vi.fn(),
      togglePerformanceTelemetry: vi.fn(),
      resetPerformanceTelemetry: vi.fn(),
    });

    const cropCommand = commands.find((command) => command.id === 'crop-image');
    expect(cropCommand?.isEnabled(useViewerStore.getState())).toBe(false);
  });

  it('enables compare command only when at least two images are available', () => {
    const toggleCompareMode = vi.fn();

    const commands = createViewerCommands({
      openFilePicker: vi.fn(),
      openFolderPicker: vi.fn(),
      goNext: vi.fn(),
      goPrev: vi.fn(),
      goFirst: vi.fn(),
      goLast: vi.fn(),
      toggleFullscreen: vi.fn().mockResolvedValue(undefined),
      saveRotation: vi.fn().mockResolvedValue(undefined),
      revealCurrentImage: vi.fn().mockResolvedValue(undefined),
      openCurrentImageInEditor: vi.fn().mockResolvedValue(undefined),
      copyCurrentImage: vi.fn().mockResolvedValue(undefined),
      copyCurrentImagePath: vi.fn().mockResolvedValue(undefined),
      deleteCurrentImage: vi.fn().mockResolvedValue(undefined),
      toggleProjector: vi.fn().mockResolvedValue(undefined),
      enterCropMode: vi.fn(),
      startSlideshow: vi.fn(),
      toggleCompareMode,
      togglePerformanceTelemetry: vi.fn(),
      resetPerformanceTelemetry: vi.fn(),
    });

    const compareCommand = commands.find((command) => command.id === 'toggle-compare');
    expect(compareCommand).toBeDefined();

    useViewerStore.setState({
      currentImagePath: 'c:/images/only.jpg',
      images: [
        {
          path: 'c:/images/only.jpg',
          file_name: 'only.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: null,
        },
      ],
    });
    expect(compareCommand?.isEnabled(useViewerStore.getState())).toBe(false);

    useViewerStore.setState({
      images: [
        {
          path: 'c:/images/only.jpg',
          file_name: 'only.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: null,
        },
        {
          path: 'c:/images/second.jpg',
          file_name: 'second.jpg',
          extension: 'jpg',
          size_bytes: 1,
          modified_at: null,
        },
      ],
    });
    expect(compareCommand?.isEnabled(useViewerStore.getState())).toBe(true);

    void compareCommand?.run();
    expect(toggleCompareMode).toHaveBeenCalledTimes(1);
  });

  it('exposes an external editor command with the expected shortcut', async () => {
    const openCurrentImageInEditor = vi.fn().mockResolvedValue(undefined);
    useViewerStore.setState({
      currentImagePath: 'c:/images/test.jpg',
    });

    const commands = createViewerCommands({
      openFilePicker: vi.fn(),
      openFolderPicker: vi.fn(),
      goNext: vi.fn(),
      goPrev: vi.fn(),
      goFirst: vi.fn(),
      goLast: vi.fn(),
      toggleFullscreen: vi.fn().mockResolvedValue(undefined),
      saveRotation: vi.fn().mockResolvedValue(undefined),
      revealCurrentImage: vi.fn().mockResolvedValue(undefined),
      openCurrentImageInEditor,
      copyCurrentImage: vi.fn().mockResolvedValue(undefined),
      copyCurrentImagePath: vi.fn().mockResolvedValue(undefined),
      deleteCurrentImage: vi.fn().mockResolvedValue(undefined),
      toggleProjector: vi.fn().mockResolvedValue(undefined),
      enterCropMode: vi.fn(),
      startSlideshow: vi.fn(),
      toggleCompareMode: vi.fn(),
      togglePerformanceTelemetry: vi.fn(),
      resetPerformanceTelemetry: vi.fn(),
    });

    const editCommand = commands.find((command) => command.id === 'open-in-editor');
    expect(editCommand?.shortcut).toBe('Ctrl+E');
    expect(editCommand?.isEnabled(useViewerStore.getState())).toBe(true);

    await editCommand?.run();
    expect(openCurrentImageInEditor).toHaveBeenCalledTimes(1);
  });

  it('exposes performance telemetry commands', () => {
    const togglePerformanceTelemetry = vi.fn();
    const resetPerformanceTelemetry = vi.fn();

    const commands = createViewerCommands({
      openFilePicker: vi.fn(),
      openFolderPicker: vi.fn(),
      goNext: vi.fn(),
      goPrev: vi.fn(),
      goFirst: vi.fn(),
      goLast: vi.fn(),
      toggleFullscreen: vi.fn().mockResolvedValue(undefined),
      saveRotation: vi.fn().mockResolvedValue(undefined),
      revealCurrentImage: vi.fn().mockResolvedValue(undefined),
      openCurrentImageInEditor: vi.fn().mockResolvedValue(undefined),
      copyCurrentImage: vi.fn().mockResolvedValue(undefined),
      copyCurrentImagePath: vi.fn().mockResolvedValue(undefined),
      deleteCurrentImage: vi.fn().mockResolvedValue(undefined),
      toggleProjector: vi.fn().mockResolvedValue(undefined),
      enterCropMode: vi.fn(),
      startSlideshow: vi.fn(),
      toggleCompareMode: vi.fn(),
      togglePerformanceTelemetry,
      resetPerformanceTelemetry,
    });

    const toggleCommand = commands.find((command) => command.id === 'toggle-performance-telemetry');
    const resetCommand = commands.find((command) => command.id === 'reset-performance-telemetry');

    expect(toggleCommand?.shortcut).toBe('Ctrl+Shift+F12');

    void toggleCommand?.run();
    void resetCommand?.run();

    expect(togglePerformanceTelemetry).toHaveBeenCalledTimes(1);
    expect(resetPerformanceTelemetry).toHaveBeenCalledTimes(1);
  });

  it('exposes a projector command when an image is open', async () => {
    const toggleProjector = vi.fn().mockResolvedValue(undefined);
    useViewerStore.setState({
      currentImagePath: 'c:/images/test.jpg',
    });

    const commands = createViewerCommands({
      openFilePicker: vi.fn(),
      openFolderPicker: vi.fn(),
      goNext: vi.fn(),
      goPrev: vi.fn(),
      goFirst: vi.fn(),
      goLast: vi.fn(),
      toggleFullscreen: vi.fn().mockResolvedValue(undefined),
      saveRotation: vi.fn().mockResolvedValue(undefined),
      revealCurrentImage: vi.fn().mockResolvedValue(undefined),
      openCurrentImageInEditor: vi.fn().mockResolvedValue(undefined),
      copyCurrentImage: vi.fn().mockResolvedValue(undefined),
      copyCurrentImagePath: vi.fn().mockResolvedValue(undefined),
      deleteCurrentImage: vi.fn().mockResolvedValue(undefined),
      toggleProjector,
      enterCropMode: vi.fn(),
      startSlideshow: vi.fn(),
      toggleCompareMode: vi.fn(),
      togglePerformanceTelemetry: vi.fn(),
      resetPerformanceTelemetry: vi.fn(),
    });

    const projectorCommand = commands.find((command) => command.id === 'toggle-projector');

    expect(projectorCommand?.isEnabled(useViewerStore.getState())).toBe(true);
    await projectorCommand?.run();
    expect(toggleProjector).toHaveBeenCalledTimes(1);
  });
});

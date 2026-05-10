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
    const copyCurrentImage = vi.fn().mockResolvedValue(undefined);
    const deleteCurrentImage = vi.fn().mockResolvedValue(undefined);

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
      copyCurrentImage,
      deleteCurrentImage,
      startSlideshow: vi.fn(),
    });

    const state = useViewerStore.getState();
    const saveRotationCommand = commands.find((command) => command.id === 'save-rotation');
    const revealCommand = commands.find((command) => command.id === 'reveal-in-folder');
    const copyCommand = commands.find((command) => command.id === 'copy-to-clipboard');
    const deleteCommand = commands.find((command) => command.id === 'delete-image');

    expect(saveRotationCommand?.isEnabled(state)).toBe(true);
    expect(revealCommand?.isEnabled(state)).toBe(true);
    expect(copyCommand?.isEnabled(state)).toBe(true);
    expect(deleteCommand?.isEnabled(state)).toBe(true);

    await saveRotationCommand?.run();
    await revealCommand?.run();
    await copyCommand?.run();
    await deleteCommand?.run();

    expect(saveRotation).toHaveBeenCalledTimes(1);
    expect(revealCurrentImage).toHaveBeenCalledTimes(1);
    expect(copyCurrentImage).toHaveBeenCalledTimes(1);
    expect(deleteCurrentImage).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import { DEFAULT_SETTINGS } from '../types/settings';
import { setReviewDecisionForCurrentImage } from './reviewDecisionActions';

const { writeImageCurationMock } = vi.hoisted(() => ({
  writeImageCurationMock: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock('./tauriCommands', () => ({
  readCurationMetadata: vi.fn(),
  readCurationMetadataForPaths: vi.fn(),
  writeImageCuration: writeImageCurationMock,
  writeImageCurationBatch: vi.fn((): Promise<void> => Promise.resolve()),
  resetImageReviewDecision: vi.fn((): Promise<void> => Promise.resolve()),
  clearImageCuration: vi.fn((): Promise<void> => Promise.resolve()),
}));

function image(path: string) {
  return { path, file_name: path, extension: 'jpg', size_bytes: 0, modified_at: null };
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = () => fail(new Error('write failed'));
  });
  return { promise, resolve, reject };
}

describe('setReviewDecisionForCurrentImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCurationStore.setState({
      curationByPath: {},
      favoritePaths: new Set(),
      mutationStatus: 'idle',
      mutationError: null,
      failedOperation: null,
      errorDismissed: false,
    });
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: false },
    });
    useViewerStore.getState().reset();
    useViewerStore.getState().setImages([image('1.jpg'), image('2.jpg'), image('3.jpg')]);
    useViewerStore.getState().setCurrentIndex(0);
  });

  it('does not auto-advance when the setting is off', async () => {
    await setReviewDecisionForCurrentImage('keep');

    expect(writeImageCurationMock).toHaveBeenCalledWith('1.jpg', false, 0, 'keep');
    expect(useViewerStore.getState().currentImagePath).toBe('1.jpg');
  });

  it('auto-advances once after a successful viewer decision using pre-mutation order', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });

    await setReviewDecisionForCurrentImage('keep');

    expect(useViewerStore.getState().currentImagePath).toBe('2.jpg');
  });

  it('selects the next surviving image when the current filter removes the reviewed image', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    useViewerStore.getState().setCurationFilter('unreviewed');

    await setReviewDecisionForCurrentImage('keep');

    expect(useViewerStore.getState().images.map((entry) => entry.path)).toEqual(['2.jpg', '3.jpg']);
    expect(useViewerStore.getState().currentImagePath).toBe('2.jpg');
  });

  it('does not write or advance for an unchanged decision', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });

    await setReviewDecisionForCurrentImage('unreviewed');

    expect(writeImageCurationMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().currentImagePath).toBe('1.jpg');
  });

  it('honors a rapid reset to the original status after an in-flight decision', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    const firstWrite = createDeferredVoid();
    writeImageCurationMock.mockReturnValueOnce(firstWrite.promise);

    const keep = setReviewDecisionForCurrentImage('keep');
    const reset = setReviewDecisionForCurrentImage('unreviewed');
    firstWrite.resolve();
    await Promise.all([keep, reset]);

    expect(writeImageCurationMock).toHaveBeenNthCalledWith(1, '1.jpg', false, 0, 'keep');
    expect(writeImageCurationMock).toHaveBeenNthCalledWith(2, '1.jpg', false, 0, 'unreviewed');
    expect(useCurationStore.getState().curationByPath['1.jpg']).toBeUndefined();
    expect(useViewerStore.getState().currentImagePath).toBe('2.jpg');
  });

  it('stops at the last image without wrapping', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    useViewerStore.getState().setCurrentIndex(2);

    await setReviewDecisionForCurrentImage('reject');

    expect(useViewerStore.getState().currentImagePath).toBe('3.jpg');
  });

  it('does not advance when persistence fails', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    writeImageCurationMock.mockRejectedValueOnce(new Error('write failed'));

    await expect(setReviewDecisionForCurrentImage('reject')).rejects.toThrow('write failed');

    expect(useViewerStore.getState().currentImagePath).toBe('1.jpg');
  });

  it('ignores stale rapid-input completions and advances only for the newest write', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    const firstWrite = createDeferredVoid();
    const secondWrite = createDeferredVoid();
    writeImageCurationMock
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);

    const firstDecision = setReviewDecisionForCurrentImage('keep');
    const secondDecision = setReviewDecisionForCurrentImage('reject');

    firstWrite.resolve();
    await firstDecision;
    expect(useViewerStore.getState().currentImagePath).toBe('1.jpg');

    secondWrite.resolve();
    await secondDecision;
    expect(useViewerStore.getState().currentImagePath).toBe('2.jpg');
  });

  it('does not sync or advance when the user manually navigates during persistence', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    const write = createDeferredVoid();
    writeImageCurationMock.mockReturnValueOnce(write.promise);

    const decision = setReviewDecisionForCurrentImage('keep');
    useViewerStore.getState().setCurrentIndex(1);

    write.resolve();
    await decision;

    expect(useViewerStore.getState().currentImagePath).toBe('2.jpg');
    expect(useViewerStore.getState().curationStateByPath).toEqual({});
  });

  it('does not sync or advance when the active curation filter changes during persistence', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    const write = createDeferredVoid();
    writeImageCurationMock.mockReturnValueOnce(write.promise);

    const decision = setReviewDecisionForCurrentImage('keep');
    useViewerStore.getState().setCurationFilter('keep');

    write.resolve();
    await decision;

    expect(useViewerStore.getState().curationFilter).toBe('keep');
    expect(useViewerStore.getState().curationStateByPath).toEqual({});
  });

  it('does not sync or advance when view mode changes during persistence', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
    });
    const write = createDeferredVoid();
    writeImageCurationMock.mockReturnValueOnce(write.promise);

    const decision = setReviewDecisionForCurrentImage('keep');
    useViewerStore.getState().setViewMode('grid');

    write.resolve();
    await decision;

    expect(useViewerStore.getState().viewMode).toBe('grid');
    expect(useViewerStore.getState().currentImagePath).toBe('1.jpg');
    expect(useViewerStore.getState().curationStateByPath).toEqual({});
  });

  it.each(['keep', 'reject'] as const)(
    'removes the last unreviewed image after marking it %s with auto-advance enabled',
    async (status) => {
      useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS, autoAdvanceAfterReviewDecision: true },
      });
      useViewerStore.getState().setImages([image('1.jpg')]);
      useViewerStore.getState().setCurrentIndex(0);
      useViewerStore.getState().setCurationFilter('unreviewed');

      await setReviewDecisionForCurrentImage(status);

      expect(useViewerStore.getState().images).toEqual([]);
      expect(useViewerStore.getState().currentImagePath).toBeNull();
      expect(useViewerStore.getState().curationFilter).toBe('unreviewed');
    }
  );
});

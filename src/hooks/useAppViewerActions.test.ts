import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppViewerActions } from './useAppViewerActions';
import { openRecentFolderSession } from '../services/tauriCommands';

vi.mock('../services/tauriCommands', () => ({
  closeSecondaryWindow: vi.fn().mockResolvedValue(undefined),
  openRecentFolderSession: vi.fn(),
  openSecondaryWindow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/runtime/runtime', () => ({
  getRuntime: () => ({
    confirm: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock('../services/performanceTelemetry', () => ({
  resetPerformanceTelemetry: vi.fn(),
  setPerformanceTelemetryEnabled: vi.fn(),
}));

function createOptions(overrides = {}) {
  return {
    appWindow: { setFullscreen: vi.fn().mockResolvedValue(undefined) },
    currentImagePath: null,
    isFullscreen: false,
    isSecondary: false,
    isProjectorOpen: false,
    applyFolderSessionSnapshot: vi.fn().mockResolvedValue(undefined),
    openFilePicker: vi.fn().mockResolvedValue(undefined),
    openFolderPicker: vi.fn().mockResolvedValue(undefined),
    goNext: vi.fn(() => true),
    goPrev: vi.fn(() => true),
    goFirst: vi.fn(),
    goLast: vi.fn(),
    refreshProjectorState: vi.fn().mockResolvedValue(undefined),
    startSlideshow: vi.fn().mockResolvedValue(undefined),
    setFullscreen: vi.fn(),
    setShowPerformanceTelemetry: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

describe('useAppViewerActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens recent folders from the authorized snapshot without reopening by path', async () => {
    const session = {
      session_id: 'sess_recent',
      canonical_folder: 'D:/Shoots/May',
      images: [],
    };
    vi.mocked(openRecentFolderSession).mockResolvedValue(session);
    const applyFolderSessionSnapshot = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAppViewerActions(createOptions({ applyFolderSessionSnapshot }) as never)
    );

    await act(async () => {
      await result.current.handleOpenRecentFolder('D:/Shoots/May', 'rated4');
    });

    expect(openRecentFolderSession).toHaveBeenCalledWith('D:/Shoots/May');
    expect(applyFolderSessionSnapshot).toHaveBeenCalledWith(session, { curationFilter: 'rated4' });
  });
});

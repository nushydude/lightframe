import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStartupLifecycle } from './useAppStartupLifecycle';

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  show: vi.fn(),
  loadSettings: vi.fn(),
  loadCuration: vi.fn(),
  openImage: vi.fn(),
  applyFolderSessionSnapshot: vi.fn(),
  applyFileSessionSnapshot: vi.fn(),
  setError: vi.fn(),
  consumeStartupSession: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../services/tauriCommands', () => ({
  consumeStartupSession: mocks.consumeStartupSession,
}));
vi.mock('../services/mainWindowRestore', () => ({
  restoreMainWindowBounds: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/windowBounds', () => ({
  waitForWindowRestoreBeforeShow: vi.fn().mockResolvedValue('completed'),
}));
vi.mock('../services/performanceTelemetry', () => ({
  recordStartupCliResolveTelemetry: vi.fn(),
  recordStartupInitialImageOpenTelemetry: vi.fn(),
  recordStartupSettingsAndCurationLoadTelemetry: vi.fn(),
}));

describe('useAppStartupLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.loadSettings.mockResolvedValue(undefined);
    mocks.loadCuration.mockResolvedValue(undefined);
    mocks.openImage.mockResolvedValue(undefined);
    mocks.applyFolderSessionSnapshot.mockResolvedValue(undefined);
    mocks.applyFileSessionSnapshot.mockResolvedValue(undefined);
    mocks.consumeStartupSession.mockResolvedValue({ mode: 'empty' });
  });

  it('loads settings and resolves startup before showing the main window', async () => {
    const appWindow = { label: 'main', show: mocks.show } as never;
    renderHook(() =>
      useAppStartupLifecycle({
        appWindow,
        isMainWindow: true,
        isProjectorWindow: false,
        loadSettings: mocks.loadSettings,
        loadCuration: mocks.loadCuration,
        openImage: mocks.openImage,
        applyFolderSessionSnapshot: mocks.applyFolderSessionSnapshot,
        applyFileSessionSnapshot: mocks.applyFileSessionSnapshot,
        setError: mocks.setError,
      })
    );

    await waitFor(() => expect(mocks.loadSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
    expect(mocks.loadCuration).toHaveBeenCalledTimes(1);
  });

  it('applies startup snapshots directly instead of reopening by path', async () => {
    const startupSession = {
      session_id: 'sess_startup',
      requested_image_id: 'img_requested',
      canonical_folder: 'C:/Photos',
      images: [
        {
          id: 'img_requested',
          path: 'C:/Photos/requested.jpg',
          file_name: 'requested.jpg',
          extension: 'jpg',
          size_bytes: 1,
        },
      ],
    };
    mocks.consumeStartupSession.mockResolvedValue({
      mode: 'image',
      session: startupSession,
    });

    renderHook(() =>
      useAppStartupLifecycle({
        appWindow: { label: 'main', show: mocks.show } as never,
        isMainWindow: true,
        isProjectorWindow: false,
        loadSettings: mocks.loadSettings,
        loadCuration: mocks.loadCuration,
        openImage: mocks.openImage,
        applyFolderSessionSnapshot: mocks.applyFolderSessionSnapshot,
        applyFileSessionSnapshot: mocks.applyFileSessionSnapshot,
        setError: mocks.setError,
      })
    );

    await waitFor(() =>
      expect(mocks.applyFileSessionSnapshot).toHaveBeenCalledWith(startupSession, {
        startup: true,
      })
    );
  });
});

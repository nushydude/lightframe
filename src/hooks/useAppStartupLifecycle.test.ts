import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStartupLifecycle } from './useAppStartupLifecycle';

const mocks = vi.hoisted(() => ({
  getMatches: vi.fn(),
  listen: vi.fn(),
  show: vi.fn(),
  loadSettings: vi.fn(),
  loadCuration: vi.fn(),
  openFolder: vi.fn(),
  openImage: vi.fn(),
  openImageForStartup: vi.fn(),
  setError: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-cli', () => ({ getMatches: mocks.getMatches }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
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
    mocks.getMatches.mockResolvedValue({ args: { file: null, folder: null } });
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.loadSettings.mockResolvedValue(undefined);
    mocks.loadCuration.mockResolvedValue(undefined);
    mocks.openFolder.mockResolvedValue(undefined);
    mocks.openImage.mockResolvedValue(undefined);
    mocks.openImageForStartup.mockResolvedValue(undefined);
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
        openFolder: mocks.openFolder,
        openImage: mocks.openImage,
        openImageForStartup: mocks.openImageForStartup,
        setError: mocks.setError,
      })
    );

    await waitFor(() => expect(mocks.loadSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
    expect(mocks.loadCuration).toHaveBeenCalledTimes(1);
  });
});

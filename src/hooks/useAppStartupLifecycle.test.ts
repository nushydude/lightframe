import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStartupLifecycle } from './useAppStartupLifecycle';
import { initializeRuntime } from '../services/runtime/runtime';
import { createTestRuntimeAdapter } from '../services/runtime/testAdapter';

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
    mocks.getMatches.mockResolvedValue({});
    mocks.listen.mockResolvedValue(vi.fn());
    initializeRuntime(
      createTestRuntimeAdapter({ startupArguments: mocks.getMatches, listen: mocks.listen })
    );
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

  it('runs startup once and cleans its listener under Strict Mode', async () => {
    const cleanup = vi.fn();
    mocks.listen.mockResolvedValue(cleanup);
    const appWindow = { label: 'main', show: mocks.show } as never;
    const { unmount } = renderHook(
      () =>
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
        }),
      { wrapper: StrictMode }
    );
    await waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
    expect(mocks.getMatches).toHaveBeenCalledTimes(1);
    expect(mocks.loadSettings).toHaveBeenCalledTimes(1);
    expect(mocks.loadCuration).toHaveBeenCalledTimes(1);
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    unmount();
    await waitFor(() => expect(cleanup).toHaveBeenCalled());
  });
});

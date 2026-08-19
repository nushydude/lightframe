import { useCallback, useEffect, useRef, useState } from 'react';
import { getRuntime } from '../services/runtime/runtime';
import type { RuntimeWindow } from '../services/runtime/types';
import { useSettingsStore } from '../state/settingsStore';
import { CurationPersistenceError } from '../state/curationStore';
import { useViewerStore } from '../state/viewerStore';
import { consumeStartupSession } from '../services/tauriCommands';
import type { FileSessionSnapshot, FolderSessionSnapshot } from '../services/tauriCommands';
import {
  recordStartupCliResolveTelemetry,
  recordStartupInitialImageOpenTelemetry,
  recordStartupSettingsAndCurationLoadTelemetry,
} from '../services/performanceTelemetry';
import { restoreMainWindowBounds } from '../services/mainWindowRestore';
import { waitForWindowRestoreBeforeShow } from '../services/windowBounds';

const STARTUP_WINDOW_RESTORE_TIMEOUT_MS = 750;
const STARTUP_WINDOW_SHOW_WATCHDOG_MS = 2000;

type StartupLifecycleOptions = {
  appWindow: RuntimeWindow;
  isMainWindow: boolean;
  isProjectorWindow: boolean;
  loadSettings: () => Promise<unknown>;
  loadCuration: () => Promise<unknown>;
  openImage: (imagePath: string) => Promise<unknown>;
  applyFolderSessionSnapshot: (session: FolderSessionSnapshot) => Promise<unknown>;
  applyFileSessionSnapshot: (
    session: FileSessionSnapshot,
    options?: { startup?: boolean }
  ) => Promise<unknown>;
  setError: (message: string | null) => void;
};

async function restoreStartupWindowBeforeShow({
  appWindow,
  isMainWindow,
  isProjectorWindow,
  loadSettings,
  isCancelled,
}: Pick<
  StartupLifecycleOptions,
  'appWindow' | 'isMainWindow' | 'isProjectorWindow' | 'loadSettings'
> & {
  isCancelled: () => boolean;
}) {
  await loadSettings();
  if (isCancelled()) return;

  const loadedSettings = useSettingsStore.getState().settings;
  const loadedDefaultFitMode = isProjectorWindow ? 'fit' : loadedSettings.defaultFitMode;
  useViewerStore.getState().setDefaultZoomMode(loadedDefaultFitMode);

  let canContinueRestore = true;
  const restoreResult = await waitForWindowRestoreBeforeShow(
    isMainWindow
      ? restoreMainWindowBounds(
          appWindow,
          loadedSettings,
          () => !isCancelled() && canContinueRestore
        )
      : Promise.resolve(),
    STARTUP_WINDOW_RESTORE_TIMEOUT_MS
  );
  if (restoreResult !== 'completed') {
    canContinueRestore = false;
    console.warn(`Skipped startup window restore before show: ${restoreResult}`);
  }
}

async function openStartupTarget({
  isMainWindow,
  applyFolderSessionSnapshot,
  applyFileSessionSnapshot,
}: Pick<
  StartupLifecycleOptions,
  'isMainWindow' | 'applyFolderSessionSnapshot' | 'applyFileSessionSnapshot'
>) {
  if (!isMainWindow) return;

  const cliResolveStartedAt = performance.now();
  const startupDecision = await consumeStartupSession();
  recordStartupCliResolveTelemetry(performance.now() - cliResolveStartedAt);

  if (startupDecision.mode === 'folder') {
    await applyFolderSessionSnapshot(startupDecision.session);
  } else if (startupDecision.mode === 'image') {
    const startupImageOpenStartedAt = performance.now();
    await applyFileSessionSnapshot(startupDecision.session, { startup: true });
    recordStartupInitialImageOpenTelemetry(performance.now() - startupImageOpenStartedAt);
  }
}

/** Owns startup argument handling, persisted window restoration, and first-show readiness. */
export function useAppStartupLifecycle({
  appWindow,
  isMainWindow,
  isProjectorWindow,
  loadSettings,
  loadCuration,
  openImage,
  applyFolderSessionSnapshot,
  applyFileSessionSnapshot,
  setError,
}: StartupLifecycleOptions) {
  const [hasStartupResolved, setHasStartupResolved] = useState(false);
  const [startupShowAttempted, setStartupShowAttempted] = useState(false);
  const startupShowAttemptedRef = useRef(false);

  const showMainWindowOnce = useCallback(async () => {
    if (!isMainWindow || startupShowAttemptedRef.current) return;
    startupShowAttemptedRef.current = true;
    setStartupShowAttempted(true);

    try {
      await appWindow.show();
    } catch (error) {
      console.error('Failed to show main window:', error);
    }
  }, [appWindow, isMainWindow]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isCancelled = false;

    async function init() {
      const settingsLoadStartedAt = performance.now();
      await restoreStartupWindowBeforeShow({
        appWindow,
        isMainWindow,
        isProjectorWindow,
        loadSettings,
        isCancelled: () => isCancelled,
      });

      try {
        await openStartupTarget({
          isMainWindow,
          applyFolderSessionSnapshot,
          applyFileSessionSnapshot,
        });
      } catch (error) {
        console.error('Failed to open startup session:', error);
        setError(`Could not open startup file or folder: ${error}`);
      } finally {
        if (!isCancelled && !useViewerStore.getState().folderPath) {
          await loadCuration().catch((error: unknown) => {
            if (!(error instanceof CurationPersistenceError)) {
              console.error('Failed to load curation metadata:', error);
            }
          });
        }
        recordStartupSettingsAndCurationLoadTelemetry(performance.now() - settingsLoadStartedAt);
        if (!isCancelled) {
          setHasStartupResolved(true);
        }
      }
    }

    void init();

    if (isMainWindow) {
      void getRuntime()
        .listen<string>('open-file', async (path) => {
          await openImage(path);
        })
        .then((fn) => {
          unlisten = fn;
        })
        .catch((error) => console.error('Failed to listen for open-file:', error));
    }

    return () => {
      isCancelled = true;
      if (unlisten) unlisten();
    };
  }, [
    appWindow,
    isMainWindow,
    isProjectorWindow,
    loadCuration,
    loadSettings,
    openImage,
    applyFolderSessionSnapshot,
    applyFileSessionSnapshot,
    setError,
  ]);

  useEffect(() => {
    if (!isMainWindow || startupShowAttempted) return;
    const timeoutId = setTimeout(() => {
      void showMainWindowOnce();
    }, STARTUP_WINDOW_SHOW_WATCHDOG_MS);
    return () => clearTimeout(timeoutId);
  }, [isMainWindow, showMainWindowOnce, startupShowAttempted]);

  useEffect(() => {
    if (!isMainWindow || !hasStartupResolved || startupShowAttempted) return;
    void showMainWindowOnce();
  }, [hasStartupResolved, isMainWindow, showMainWindowOnce, startupShowAttempted]);
}

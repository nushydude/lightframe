import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getMatches } from '@tauri-apps/plugin-cli';
import type { Window } from '@tauri-apps/api/window';
import { useSettingsStore } from '../state/settingsStore';
import { CurationPersistenceError } from '../state/curationStore';
import { useViewerStore } from '../state/viewerStore';
import { resolveStartupDecision } from '../services/startup';
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
  appWindow: Window;
  isMainWindow: boolean;
  isProjectorWindow: boolean;
  loadSettings: () => Promise<unknown>;
  loadCuration: () => Promise<unknown>;
  openFolder: (folderPath: string) => Promise<unknown>;
  openImage: (imagePath: string) => Promise<unknown>;
  openImageForStartup: (imagePath: string) => Promise<unknown>;
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
  openFolder,
  openImageForStartup,
}: Pick<StartupLifecycleOptions, 'isMainWindow' | 'openFolder' | 'openImageForStartup'>) {
  if (!isMainWindow) return;

  const cliResolveStartedAt = performance.now();
  const matches = await getMatches();
  const startupDecision = resolveStartupDecision(matches.args.file, matches.args.folder);
  recordStartupCliResolveTelemetry(performance.now() - cliResolveStartedAt);

  if (startupDecision.mode === 'open-folder' && startupDecision.folderPath) {
    await openFolder(startupDecision.folderPath);
  } else if (startupDecision.mode === 'open-image' && startupDecision.filePath) {
    const startupImageOpenStartedAt = performance.now();
    await openImageForStartup(startupDecision.filePath);
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
  openFolder,
  openImage,
  openImageForStartup,
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
        await openStartupTarget({ isMainWindow, openFolder, openImageForStartup });
      } catch (error) {
        console.error('Failed to parse CLI args on startup:', error);
        setError(`Failed to parse CLI args on startup: ${error}`);
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
      void listen<string>('open-file', async (event) => {
        await openImage(event.payload);
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
    openFolder,
    openImage,
    openImageForStartup,
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

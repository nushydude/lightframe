import { useEffect, useRef, type MutableRefObject } from 'react';
import { getRuntime } from '../services/runtime/runtime';
import type { RuntimeWindow } from '../services/runtime/types';
import { useSettingsStore } from '../state/settingsStore';
import { displayKeyFromMonitor, persistWindowBoundsSafely } from '../services/windowBounds';

type WindowPersistenceOptions = {
  appWindow: RuntimeWindow;
  isMainWindow: boolean;
  settingsRef: MutableRefObject<ReturnType<typeof useSettingsStore.getState>['settings']>;
  settingsLoadedRef: MutableRefObject<boolean>;
  updateSettings: (
    partial: Partial<ReturnType<typeof useSettingsStore.getState>['settings']>
  ) => Promise<unknown>;
};

/** Persists main-window bounds while keeping Tauri listener/timer lifecycle out of App. */
export function useWindowPersistence({
  appWindow,
  isMainWindow,
  settingsRef,
  settingsLoadedRef,
  updateSettings,
}: WindowPersistenceOptions) {
  const saveBoundsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isMainWindow) return;

    let isUnmounted = false;
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;

    const persistWindowBounds = async () => {
      try {
        settingsRef.current = useSettingsStore.getState().settings;
        if (!settingsRef.current.rememberWindowBounds) return;

        await persistWindowBoundsSafely({
          isUnmounted: () => isUnmounted,
          isSettingsLoaded: settingsLoadedRef.current,
          isMainWindow: true,
          settings: settingsRef.current,
          readWindowFlags: async () => {
            const [isFullscreen, isMinimized] = await Promise.all([
              appWindow.isFullscreen(),
              appWindow.isMinimized(),
            ]);
            return { isFullscreen, isMinimized };
          },
          readWindowBounds: async () => {
            const [position, size] = await Promise.all([
              appWindow.outerPosition(),
              appWindow.innerSize(),
            ]);
            return { position, size };
          },
          readDisplayKey: async () => displayKeyFromMonitor(await getRuntime().currentMonitor()),
          updateSettings: async (partial) => {
            if (!isUnmounted) await updateSettings(partial);
          },
        });
      } catch (error) {
        console.error('Failed to persist window bounds:', error);
      }
    };

    const scheduleWindowBoundsPersist = () => {
      if (saveBoundsTimerRef.current) clearTimeout(saveBoundsTimerRef.current);
      saveBoundsTimerRef.current = setTimeout(() => {
        saveBoundsTimerRef.current = null;
        void persistWindowBounds();
      }, 500);
    };

    appWindow
      .onMoved(scheduleWindowBoundsPersist)
      .then((unlisten) => {
        if (isUnmounted) unlisten();
        else unlistenMoved = unlisten;
      })
      .catch((error) => console.error('Failed to attach window move listener:', error));

    appWindow
      .onResized(scheduleWindowBoundsPersist)
      .then((unlisten) => {
        if (isUnmounted) unlisten();
        else unlistenResized = unlisten;
      })
      .catch((error) => console.error('Failed to attach window resize listener:', error));

    return () => {
      isUnmounted = true;
      if (saveBoundsTimerRef.current) {
        clearTimeout(saveBoundsTimerRef.current);
        saveBoundsTimerRef.current = null;
      }
      unlistenMoved?.();
      unlistenResized?.();
    };
  }, [appWindow, isMainWindow, settingsLoadedRef, settingsRef, updateSettings]);
}

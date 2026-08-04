import { useEffect, useState } from 'react';
import { getRuntime } from '../services/runtime/runtime';
import type { RuntimeWindow } from '../services/runtime/types';
import { useViewerStore } from '../state/viewerStore';
import { emitStateSync, requestStateSync } from '../services/tauriCommands';

type ProjectorSyncLifecycleOptions = {
  appWindow: RuntimeWindow;
  currentImagePath: string | null;
  openImage: (imagePath: string) => Promise<unknown>;
};

/** Owns secondary-window identity and bidirectional projector state synchronization. */
export function useProjectorSyncLifecycle({
  appWindow,
  currentImagePath,
  openImage,
}: ProjectorSyncLifecycleOptions) {
  const [isSecondary, setIsSecondary] = useState(false);

  useEffect(() => {
    setIsSecondary(appWindow.label === 'secondary');
  }, [appWindow]);

  useEffect(() => {
    if (!isSecondary) return;

    const unlisten = getRuntime().listen<{
      imagePath: string | null;
      source: 'main' | 'secondary';
    }>('state-sync', (payload) => {
      if (payload.source !== 'main' || !payload.imagePath) return;

      const state = useViewerStore.getState();
      const nextIndex = state.images.findIndex((image) => image.path === payload.imagePath);
      if (nextIndex >= 0) {
        state.setCurrentIndex(nextIndex, { zoomMode: 'fit' });
        return;
      }
      void openImage(payload.imagePath);
    });
    requestStateSync().catch((error) => console.error('Failed to request projector state:', error));

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isSecondary, openImage]);

  useEffect(() => {
    if (!isSecondary || !currentImagePath) return;

    void emitStateSync(currentImagePath, 'secondary').catch((error) =>
      console.error('Failed to sync projector navigation state:', error)
    );
  }, [currentImagePath, isSecondary]);

  useEffect(() => {
    if (isSecondary) return;

    const unlisten = getRuntime().listen<{
      imagePath: string | null;
      source: 'main' | 'secondary';
    }>('state-sync', (payload) => {
      if (payload.source !== 'secondary') return;

      const nextPath = payload.imagePath;
      if (!nextPath || nextPath === useViewerStore.getState().currentImagePath) return;

      const state = useViewerStore.getState();
      const nextIndex = state.images.findIndex((image) => image.path === nextPath);
      if (nextIndex >= 0) {
        state.setCurrentIndex(nextIndex);
        return;
      }
      void openImage(nextPath);
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isSecondary, openImage]);

  useEffect(() => {
    if (isSecondary) return;

    const unlisten = getRuntime().listen('state-sync-request', () => {
      if (currentImagePath) {
        emitStateSync(currentImagePath, 'main').catch((error) =>
          console.error('Failed to sync projector state:', error)
        );
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [currentImagePath, isSecondary]);

  useEffect(() => {
    if (isSecondary || !currentImagePath) return;
    void emitStateSync(currentImagePath, 'main').catch((error) =>
      console.error('Failed to sync projector state:', error)
    );
  }, [currentImagePath, isSecondary]);

  return isSecondary;
}

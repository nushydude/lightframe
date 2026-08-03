import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ImageFile } from '../types/image';
import {
  listenToFolderWatcherChanges,
  unwatchFolder,
  watchFolder,
  type FolderWatcherPayload,
} from '../services/tauriCommands';
import { invalidateImageAsset } from '../services/imageAssetCache';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { reconcileFolderWatcherPayload } from '../services/folderWatcherReconciliation';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { pathIdentityKey } from '../services/pathIdentity';

type ApplyFolderImages = (
  images: ImageFile[],
  options: {
    emptyMessage: string;
    preferredIndex: number;
    preferredPath: string | null;
    pathIndex: Map<string, bigint>;
  }
) => void;

type FolderWatcherLifecycleOptions = {
  isMainWindow: boolean;
  folderPath: string | null;
  autoRefreshFolder: boolean;
  isFolderScanning: boolean;
  randomOrderRef: MutableRefObject<string[] | null>;
  folderPathIndexRef: MutableRefObject<Map<string, bigint>>;
  applyFolderImages: ApplyFolderImages;
  refreshFolderFromDisk: () => Promise<void>;
};

function normalizePathKey(path: string): string {
  return pathIdentityKey(path);
}

/** Owns watcher subscription, queued refreshes, and incremental payload application. */
export function useFolderWatcherLifecycle({
  isMainWindow,
  folderPath,
  autoRefreshFolder,
  isFolderScanning,
  randomOrderRef,
  folderPathIndexRef,
  applyFolderImages,
  refreshFolderFromDisk,
}: FolderWatcherLifecycleOptions) {
  const pendingWatcherRefreshFolderRef = useRef<string | null>(null);

  const handleFolderWatcherPayload = useCallback(
    (payload: FolderWatcherPayload) => {
      const state = useViewerStore.getState();
      if (
        !state.folderPath ||
        normalizePathKey(state.folderPath) !== normalizePathKey(payload.folderPath)
      ) {
        return;
      }

      if (state.isFolderScanning) {
        pendingWatcherRefreshFolderRef.current = state.folderPath;
        return;
      }

      const settings = useSettingsStore.getState().settings;
      const reconciliation = reconcileFolderWatcherPayload({
        payload,
        images: state.allImages.length > 0 ? state.allImages : state.images,
        currentIndex: state.currentIndex,
        currentImagePath: state.currentImagePath,
        sortOrder: settings.sortOrder,
        sortDirection: settings.sortDirection,
        randomOrder: randomOrderRef.current,
        pathIndex: folderPathIndexRef.current,
      });

      if (reconciliation.requiresFullRefresh) {
        void refreshFolderFromDisk();
        return;
      }

      if (settings.sortOrder === 'random') {
        randomOrderRef.current = reconciliation.images.map((image) => image.path);
      }

      for (const path of reconciliation.invalidatedPaths) {
        invalidateThumbnail(path);
        invalidateImageAsset(path);
      }

      if (
        state.currentImagePath &&
        reconciliation.invalidatedPaths.some(
          (path) => normalizePathKey(path) === normalizePathKey(state.currentImagePath ?? '')
        )
      ) {
        useViewerStore.setState({ cacheBuster: Date.now() });
      }

      applyFolderImages(reconciliation.images, {
        emptyMessage: 'No supported images found in the current folder',
        preferredIndex: reconciliation.preferredIndex,
        preferredPath: reconciliation.preferredPath,
        pathIndex: folderPathIndexRef.current,
      });
    },
    [applyFolderImages, folderPathIndexRef, randomOrderRef, refreshFolderFromDisk]
  );

  const handleFolderWatcherPayloadRef = useRef(handleFolderWatcherPayload);
  useEffect(() => {
    handleFolderWatcherPayloadRef.current = handleFolderWatcherPayload;
  }, [handleFolderWatcherPayload]);

  useEffect(() => {
    if (isFolderScanning) return;

    const dirtyFolderPath = pendingWatcherRefreshFolderRef.current;
    if (!dirtyFolderPath) return;

    pendingWatcherRefreshFolderRef.current = null;
    if (!folderPath || normalizePathKey(folderPath) !== normalizePathKey(dirtyFolderPath)) return;

    void refreshFolderFromDisk();
  }, [folderPath, isFolderScanning, refreshFolderFromDisk]);

  useEffect(() => {
    if (!isMainWindow || !folderPath || !autoRefreshFolder) return;

    const watchId = `folder-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        unlisten = await listenToFolderWatcherChanges((payload) =>
          handleFolderWatcherPayloadRef.current(payload)
        );
        if (disposed) {
          unlisten();
          return;
        }

        await watchFolder(folderPath, watchId);
        if (disposed) await unwatchFolder(watchId);
      } catch (error) {
        console.warn('Failed to start folder watcher:', error);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      void unwatchFolder(watchId).catch((error) => {
        console.warn('Failed to stop folder watcher:', error);
      });
    };
  }, [autoRefreshFolder, folderPath, isMainWindow]);
}

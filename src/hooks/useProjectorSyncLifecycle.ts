import { useCallback, useEffect, useRef } from 'react';
import { getRuntime } from '../services/runtime/runtime';
import type { RuntimeWindow } from '../services/runtime/types';
import {
  hydrateProjectorSelection,
  registerProjectorNavigationHandler,
  useViewerStore,
} from '../state/viewerStore';
import type { ImageFile } from '../types/image';
import {
  adoptProjectorGrant,
  clearAdoptedProjectorGrant,
  clearProjectorSync,
  emitStateSync,
  navigateProjectorImage,
  requestStateSync,
  readProjectorDisplayRecord,
  type ProjectorDisplayRecord,
} from '../services/tauriCommands';

type ProjectorSyncPayload = {
  sessionId?: string;
  imageId?: string;
  source: 'main' | 'secondary';
};

type ProjectorSyncLifecycleOptions = {
  appWindow: RuntimeWindow;
  currentImagePath: string | null;
  activeSessionId?: string | null;
  activeImageId?: string | null;
  openImage: (path: string) => void;
  onSyncImageId?: (sessionId: string, imageId: string) => void;
};

function toImageFile(img: ImageFile, sessionId: string): ImageFile {
  return {
    id: img.id,
    sessionId,
    path: img.path,
    file_name: img.file_name,
    extension: img.extension,
    size_bytes: img.size_bytes,
    modified_at: img.modified_at ?? null,
    created_at: img.created_at ?? null,
  };
}

function hydrateStoreFromRecord(record: ProjectorDisplayRecord): void {
  const imageId = record.image.id;
  if (!imageId) return;
  const store = useViewerStore.getState();
  // Projector records are capabilities issued by the backend. Seed the path facade with exactly
  // the currently granted identity so secondary reads never fall back to open_file_session.
  adoptProjectorGrant(record.session_id, record.image);
  const images =
    record.images && record.images.length > 0
      ? record.images.map((img) => toImageFile(img, record.session_id))
      : [toImageFile(record.image, record.session_id)];
  store.setImages(images);
  if (record.images && record.images.length > 0) {
    hydrateProjectorSelection(record.session_id, imageId);
  } else {
    store.setCurrentIndex(0);
  }
}

let projectorNavigationSequence = 0;

function clearHydratedProjectorState(): void {
  clearAdoptedProjectorGrant();
  useViewerStore.getState().setImages([]);
}

/** Owns secondary-window identity and bidirectional projector state synchronization. */
export function useProjectorSyncLifecycle({
  appWindow,
  activeSessionId,
  activeImageId,
  onSyncImageId,
}: ProjectorSyncLifecycleOptions) {
  const isSecondary = appWindow.label === 'secondary';
  const secondaryNavigationRef = useRef<string | null>(null);
  const grantEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const mainSyncGenerationRef = useRef(0);
  const mainSyncQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueMainSync = useCallback((task: () => Promise<void>, description: string) => {
    const generation = ++mainSyncGenerationRef.current;
    mainSyncQueueRef.current = mainSyncQueueRef.current
      .catch(() => {})
      .then(async () => {
        if (generation !== mainSyncGenerationRef.current) return;
        await task();
      })
      .catch((error) => console.error(description, error));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isSecondary) return;
    let disposed = false;
    let syncGeneration = 0;
    let unlistenSync: (() => void) | null = null;

    const invalidateProjectorWork = () => {
      syncGeneration += 1;
      projectorNavigationSequence += 1;
    };

    const hydrateLatestRecord = async (expectedSessionId?: string, expectedImageId?: string) => {
      const generation = ++syncGeneration;
      const record = await readProjectorDisplayRecord();
      if (disposed || generation !== syncGeneration) return;
      if (
        (expectedSessionId && record.session_id !== expectedSessionId) ||
        (expectedImageId && record.image.id !== expectedImageId)
      ) {
        throw new Error('Projector display record did not match the granted synchronization state');
      }
      secondaryNavigationRef.current = `${record.session_id}:${record.image.id}`;
      grantEpochRef.current = record.grant_epoch;
      projectorNavigationSequence = Math.max(
        projectorNavigationSequence,
        record.navigation_generation
      );
      hydrateStoreFromRecord(record);
    };

    const initialize = async () => {
      unlistenSync = await getRuntime().listen<ProjectorSyncPayload>('state-sync', (payload) => {
        if (payload.source !== 'main') return;
        const { sessionId, imageId } = payload;
        if (sessionId && imageId) {
          void hydrateLatestRecord(sessionId, imageId).catch((error) =>
            console.error('Failed to refresh projector display record:', error)
          );
        } else {
          invalidateProjectorWork();
          secondaryNavigationRef.current = null;
          grantEpochRef.current = 0;
          clearHydratedProjectorState();
        }
      });
      if (disposed) {
        unlistenSync();
        unlistenSync = null;
        return;
      }
      await requestStateSync();
      if (disposed) return;
      await hydrateLatestRecord();
    };

    void initialize().catch((error) =>
      console.error('Failed to initialize projector synchronization:', error)
    );

    return () => {
      disposed = true;
      invalidateProjectorWork();
      grantEpochRef.current = 0;
      unlistenSync?.();
    };
  }, [isSecondary, onSyncImageId]);

  useEffect(() => {
    if (!isSecondary) return;
    registerProjectorNavigationHandler((target) => {
      if (!target.id || !grantEpochRef.current) return;
      const targetImageId = target.id;
      const requestedGrantEpoch = grantEpochRef.current;
      const navigationGeneration = ++projectorNavigationSequence;
      void navigateProjectorImage(targetImageId, requestedGrantEpoch, navigationGeneration)
        .then((record) => {
          if (
            !mountedRef.current ||
            navigationGeneration !== projectorNavigationSequence ||
            grantEpochRef.current !== requestedGrantEpoch ||
            record.grant_epoch !== requestedGrantEpoch
          )
            return;
          secondaryNavigationRef.current = `${record.session_id}:${record.image.id}`;
          grantEpochRef.current = record.grant_epoch;
          hydrateStoreFromRecord(record);
          return emitStateSync(record.session_id, record.image.id!);
        })
        .catch((error) => console.error('Failed to sync projector navigation state:', error));
    });
    return () => {
      projectorNavigationSequence += 1;
      registerProjectorNavigationHandler(null);
    };
  }, [isSecondary]);

  useEffect(() => {
    if (isSecondary) return;

    const unlisten = getRuntime().listen<ProjectorSyncPayload>('state-sync', (payload) => {
      if (payload.source !== 'secondary') return;
      const { sessionId, imageId } = payload;
      if (sessionId && imageId && onSyncImageId) {
        onSyncImageId(sessionId, imageId);
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isSecondary, onSyncImageId]);

  useEffect(() => {
    if (isSecondary) return;

    const unlisten = getRuntime().listen('state-sync-request', () => {
      if (activeSessionId && activeImageId) {
        enqueueMainSync(
          () => emitStateSync(activeSessionId, activeImageId),
          'Failed to sync projector state:'
        );
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [activeImageId, activeSessionId, enqueueMainSync, isSecondary]);

  useEffect(() => {
    if (isSecondary) return;
    if (!activeSessionId || !activeImageId) {
      enqueueMainSync(() => clearProjectorSync(), 'Failed to clear projector state:');
      return;
    }
    enqueueMainSync(
      () => emitStateSync(activeSessionId, activeImageId),
      'Failed to sync projector state:'
    );
  }, [activeImageId, activeSessionId, enqueueMainSync, isSecondary]);

  return isSecondary;
}

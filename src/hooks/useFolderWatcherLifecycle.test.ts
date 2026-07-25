import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFolderWatcherLifecycle } from './useFolderWatcherLifecycle';
import { useViewerStore } from '../state/viewerStore';

const watcherMocks = vi.hoisted(() => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
  watch: vi.fn().mockResolvedValue(undefined),
  unwatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/tauriCommands', () => ({
  listenToFolderWatcherChanges: watcherMocks.listen,
  watchFolder: watcherMocks.watch,
  unwatchFolder: watcherMocks.unwatch,
}));
vi.mock('../services/imageAssetCache', () => ({ invalidateImageAsset: vi.fn() }));
vi.mock('../services/thumbnailCache', () => ({ invalidateThumbnail: vi.fn() }));

describe('useFolderWatcherLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useViewerStore.getState().reset();
  });

  it('subscribes only while a main-window folder is active and auto-refresh is enabled', async () => {
    const { unmount } = renderHook(() =>
      useFolderWatcherLifecycle({
        isMainWindow: true,
        folderPath: 'C:/photos',
        autoRefreshFolder: true,
        isFolderScanning: false,
        randomOrderRef: { current: null },
        folderPathIndexRef: { current: new Map() },
        applyFolderImages: vi.fn(),
        refreshFolderFromDisk: vi.fn().mockResolvedValue(undefined),
      })
    );

    await Promise.resolve();
    expect(watcherMocks.listen).toHaveBeenCalledTimes(1);
    expect(watcherMocks.watch).toHaveBeenCalledWith('C:/photos', expect.any(String));
    unmount();
    expect(watcherMocks.unwatch).toHaveBeenCalledTimes(1);
  });
});

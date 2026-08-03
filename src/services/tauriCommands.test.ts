import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  acquireSlideshowDisplayInhibition,
  getImageCaption,
  getParentFolder,
  openFolderSession,
  selectFolderSession,
  selectFileSession,
  releaseSlideshowDisplayInhibition,
  sessionCoordinator,
  updateRecentFoldersJumpList,
} from './tauriCommands';

describe('tauriCommands path helpers', () => {
  it('preserves Windows drive roots when extracting a parent folder', () => {
    expect(getParentFolder('C:\\photo.jpg')).toBe('C:\\');
  });

  it('preserves POSIX roots when extracting a parent folder', () => {
    expect(getParentFolder('/photo.jpg')).toBe('/');
  });

  it('preserves UNC share roots when extracting a parent folder', () => {
    expect(getParentFolder('\\\\server\\share\\photo.jpg')).toBe('\\\\server\\share');
  });
});

describe('tauriCommands caption wrapper', () => {
  it('requests a same-basename image caption', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'select_file_session') {
        return {
          session_id: 'sess_1',
          requested_image_id: 'img_1',
          canonical_folder: 'C:/Images',
          images: [
            {
              id: 'img_1',
              path: 'C:/Images/photo.png',
              file_name: 'photo.png',
              extension: 'png',
              size_bytes: 1,
            },
          ],
        };
      }
      if (cmd === 'get_image_caption_by_id') {
        return {
          text: 'portrait, soft light',
          sidecar_path: 'C:/Images/photo.txt',
          extension: 'txt',
        };
      }
      return undefined;
    });

    await selectFileSession();
    await expect(getImageCaption('C:/Images/photo.png')).resolves.toMatchObject({
      text: 'portrait, soft light',
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('get_image_caption_by_id', {
      sessionId: 'sess_1',
      imageId: 'img_1',
    });
  });
});

describe('tauriCommands display inhibition wrappers', () => {
  it('invoke the native acquire and release commands', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await acquireSlideshowDisplayInhibition();
    await releaseSlideshowDisplayInhibition();

    expect(vi.mocked(invoke).mock.calls.slice(-2)).toEqual([
      ['acquire_slideshow_display_inhibition'],
      ['release_slideshow_display_inhibition'],
    ]);
  });
});

describe('tauriCommands recent folder wrappers', () => {
  it('refreshes the native Jump List without renderer-supplied paths', async () => {
    vi.mocked(invoke).mockResolvedValue(['C:/Removed']);

    await expect(updateRecentFoldersJumpList()).resolves.toEqual(['C:/Removed']);

    expect(vi.mocked(invoke).mock.calls[vi.mocked(invoke).mock.calls.length - 1]).toEqual([
      'update_recent_folders_jump_list',
    ]);
  });
});

describe('tauriCommands packaged IPC contract suite', () => {
  beforeEach(() => {
    sessionCoordinator.reset();
    vi.clearAllMocks();
  });

  it('exercises session/image/grant ID command wrappers against expected Tauri invoke commands', async () => {
    const {
      selectFolderSession,
      selectFileSession,
      closeFolderSession,
      selectDestination,
      selectExternalEditor,
      cancelMediaRequest,
      getMediaExecutorTelemetry,
      getImageMetadataById,
      getPreviewImageById,
      getThumbnailById,
      getImageTileById,
      getSessionAssetUrl,
      acknowledgeSessionAssetDeliveryResponses,
      readCurationMetadataById,
      readCurationMetadataForIds,
      writeImageCurationById,
      writeImageCurationBatchById,
      clearImageCurationById,
      trashImageById,
      copyImageById,
      moveImageById,
      transferImagesById,
      copyImageByIdToClipboard,
      launchExternalEditorById,
      getExifMetadataById,
      rotateImageById,
      saveCroppedCopyById,
      saveScaledCopyById,
      overwriteWithCropById,
    } = await import('./tauriCommands');

    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'select_folder_session') {
        return {
          session_id: 'sess_1',
          session_instance_id: 'instance_1',
          canonical_folder: 'c:/photos',
          images: [],
        } as never;
      }
      if (cmd === 'select_file_session') {
        return {
          session_id: 'sess_1',
          session_instance_id: 'instance_1',
          requested_image_id: 'img_1',
          canonical_folder: 'c:/photos',
          images: [],
        } as never;
      }
      if (cmd === 'select_destination') {
        return {
          destinationGrantId: 'dest_1',
          relativeFileName: 'out.jpg',
          selectedPath: 'C:/Out/out.jpg',
        } as never;
      }
      if (cmd === 'select_external_editor') {
        return { externalEditorGrantId: 'editor_1', selectedPath: 'C:/App.exe' } as never;
      }
      if (cmd === 'create_asset_delivery') {
        return 'delivery_backend_minted_001' as never;
      }
      if (cmd === 'release_asset_delivery') {
        return {
          closed: true,
          responseIds: ['response_backend_minted_001', 'response_backend_minted_002'],
        } as never;
      }
      if (cmd === 'acknowledge_asset_delivery_responses') {
        return true as never;
      }
      return undefined as never;
    });

    const getLastCall = () => vi.mocked(invoke).mock.calls[vi.mocked(invoke).mock.calls.length - 1];

    await selectFolderSession();
    expect(getLastCall()).toEqual(['select_folder_session']);

    await selectFileSession();
    expect(getLastCall()).toEqual(['select_file_session']);

    await closeFolderSession('sess_1');
    expect(getLastCall()).toEqual([
      'close_folder_session',
      { sessionId: 'sess_1', sessionInstanceId: 'instance_1' },
    ]);

    await selectDestination('out.jpg', 'scale-copy');
    expect(getLastCall()).toEqual([
      'select_destination',
      { suggestedFileName: 'out.jpg', operation: 'scale-copy' },
    ]);

    await selectExternalEditor();
    expect(getLastCall()).toEqual(['select_external_editor']);

    await cancelMediaRequest('req_1');
    expect(getLastCall()).toEqual(['cancel_media_request', { requestId: 'req_1' }]);

    await getMediaExecutorTelemetry();
    expect(getLastCall()).toEqual(['get_media_executor_telemetry']);

    await getImageMetadataById('sess_1', 'img_1', 'req_meta');
    expect(getLastCall()).toEqual([
      'get_image_metadata_by_id',
      { sessionId: 'sess_1', imageId: 'img_1', requestId: 'req_meta' },
    ]);

    await getPreviewImageById('sess_1', 'img_1', 1024, 1, 'req_prev');
    expect(getLastCall()).toEqual([
      'get_preview_image_by_id',
      {
        sessionId: 'sess_1',
        imageId: 'img_1',
        maxDimension: 1024,
        invalidationBust: 1,
        requestId: 'req_prev',
      },
    ]);

    await getThumbnailById('sess_1', 'img_1', 100, 'mtime', 'req_thumb');
    expect(getLastCall()).toEqual([
      'get_thumbnail_by_id',
      {
        sessionId: 'sess_1',
        imageId: 'img_1',
        sizeBytes: 100,
        modifiedAt: 'mtime',
        requestId: 'req_thumb',
      },
    ]);

    await getImageTileById('sess_1', 'img_1', 4000, 3000, 512, 0, 0, 'req_tile');
    expect(getLastCall()).toEqual([
      'get_image_tile_by_id',
      {
        sessionId: 'sess_1',
        imageId: 'img_1',
        sourceWidth: 4000,
        sourceHeight: 3000,
        tileSize: 512,
        tileX: 0,
        tileY: 0,
        requestId: 'req_tile',
      },
    ]);

    const assetUrl = await getSessionAssetUrl('sess_1', 'img_1');
    expect(assetUrl).toMatch(
      /^lightframe-asset:\/\/sess_1\/img_1\?deliveryId=delivery_[A-Za-z0-9_-]{16,}$/
    );
    const callsBeforeAck = vi.mocked(invoke).mock.calls.length;
    await acknowledgeSessionAssetDeliveryResponses(assetUrl);
    await acknowledgeSessionAssetDeliveryResponses(assetUrl);
    expect(vi.mocked(invoke).mock.calls.slice(callsBeforeAck)).toEqual([
      ['release_asset_delivery', { deliveryId: 'delivery_backend_minted_001' }],
      [
        'acknowledge_asset_delivery_responses',
        {
          deliveryId: 'delivery_backend_minted_001',
          responseId: 'response_backend_minted_001',
        },
      ],
      [
        'acknowledge_asset_delivery_responses',
        {
          deliveryId: 'delivery_backend_minted_001',
          responseId: 'response_backend_minted_002',
        },
      ],
    ]);

    await readCurationMetadataById('sess_1', 'img_1');
    expect(getLastCall()).toEqual([
      'read_curation_metadata_by_id',
      { sessionId: 'sess_1', imageId: 'img_1' },
    ]);

    await readCurationMetadataForIds('sess_1', ['img_1', 'img_2']);
    expect(getLastCall()).toEqual([
      'read_curation_metadata_for_ids',
      { sessionId: 'sess_1', imageIds: ['img_1', 'img_2'] },
    ]);

    await writeImageCurationById('sess_1', 'img_1', true, 5);
    expect(getLastCall()).toEqual([
      'write_image_curation_by_id',
      { sessionId: 'sess_1', imageId: 'img_1', favorite: true, rating: 5 },
    ]);

    await writeImageCurationBatchById('sess_1', [{ imageId: 'img_1', favorite: true, rating: 4 }]);
    expect(getLastCall()).toEqual([
      'write_image_curation_batch_by_id',
      { sessionId: 'sess_1', updates: [{ imageId: 'img_1', favorite: true, rating: 4 }] },
    ]);

    await clearImageCurationById('sess_1', 'img_1');
    expect(getLastCall()).toEqual([
      'clear_image_curation_by_id',
      { sessionId: 'sess_1', imageId: 'img_1' },
    ]);

    await trashImageById('sess_1', 'img_1');
    expect(getLastCall()).toEqual(['trash_image_by_id', { sessionId: 'sess_1', imageId: 'img_1' }]);

    await copyImageById('sess_1', 'img_1', 'dest_1');
    expect(getLastCall()).toEqual([
      'copy_image_by_id',
      { sessionId: 'sess_1', imageId: 'img_1', destinationGrantId: 'dest_1' },
    ]);

    await moveImageById('sess_1', 'img_1', 'dest_1');
    expect(getLastCall()).toEqual([
      'move_image_by_id',
      { sessionId: 'sess_1', imageId: 'img_1', destinationGrantId: 'dest_1' },
    ]);

    await transferImagesById('sess_1', ['img_1'], 'dest_1', 'copy');
    expect(getLastCall()).toEqual([
      'transfer_images_by_id',
      { sessionId: 'sess_1', imageIds: ['img_1'], destinationGrantId: 'dest_1', mode: 'copy' },
    ]);

    await copyImageByIdToClipboard('sess_1', 'img_1');
    expect(getLastCall()).toEqual([
      'copy_image_by_id_to_clipboard',
      { sessionId: 'sess_1', imageId: 'img_1' },
    ]);

    await launchExternalEditorById('sess_1', 'img_1', 'ed_1');
    expect(getLastCall()).toEqual([
      'launch_external_editor_by_id',
      { sessionId: 'sess_1', imageId: 'img_1', editorGrantId: 'ed_1' },
    ]);

    await getExifMetadataById('sess_1', 'img_1');
    expect(getLastCall()).toEqual([
      'get_exif_metadata_by_id',
      { sessionId: 'sess_1', imageId: 'img_1' },
    ]);

    await rotateImageById('sess_1', 'img_1', 90);
    expect(getLastCall()).toEqual([
      'rotate_image_by_id',
      { sessionId: 'sess_1', imageId: 'img_1', rotationDegrees: 90 },
    ]);

    await saveCroppedCopyById(
      'sess_1',
      'img_1',
      { x: 0, y: 0, width: 100, height: 100 },
      'dest_1',
      'crop.png',
      0
    );
    expect(getLastCall()).toEqual([
      'save_cropped_copy_by_id',
      {
        sessionId: 'sess_1',
        imageId: 'img_1',
        cropRect: { x: 0, y: 0, width: 100, height: 100 },
        destinationGrantId: 'dest_1',
        relativeFileName: 'crop.png',
        rotationDegrees: 0,
      },
    ]);

    await saveScaledCopyById('sess_1', 'img_1', 'dest_1', 'scale.png', 800, 600, 1, 0);
    expect(getLastCall()).toEqual([
      'save_scaled_copy_by_id',
      {
        sessionId: 'sess_1',
        imageId: 'img_1',
        destinationGrantId: 'dest_1',
        relativeFileName: 'scale.png',
        width: 800,
        height: 600,
        smoothing: 1,
        sharpening: 0,
      },
    ]);

    await overwriteWithCropById('sess_1', 'img_1', { x: 0, y: 0, width: 100, height: 100 });
    expect(getLastCall()).toEqual([
      'overwrite_with_crop_by_id',
      {
        sessionId: 'sess_1',
        imageId: 'img_1',
        cropRect: { x: 0, y: 0, width: 100, height: 100 },
        rotationDegrees: undefined,
      },
    ]);
  });

  it('rejects out-of-order stale native selections and closes them in backend', async () => {
    let resolveFirst: (value: unknown) => void;
    let resolveSecond: (value: unknown) => void;

    const p1 = new Promise((r) => {
      resolveFirst = r;
    });
    const p2 = new Promise((r) => {
      resolveSecond = r;
    });

    let selectionCall = 0;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'select_folder_session') {
        selectionCall += 1;
        if (selectionCall === 1) {
          await p1;
          return { session_id: 'sess_slow_1', canonical_folder: 'c:/folder_1', images: [] };
        }
        if (selectionCall === 2) {
          await p2;
          return { session_id: 'sess_fast_2', canonical_folder: 'c:/folder_2', images: [] };
        }
      }
      return undefined;
    });

    const req1 = selectFolderSession();
    const req2 = selectFolderSession();

    // Fast second request completes first
    resolveSecond!(undefined);
    await expect(req2).resolves.toMatchObject({ session_id: 'sess_fast_2' });

    // Slow first request completes second
    resolveFirst!(undefined);
    await expect(req1).rejects.toThrow('superseded by a newer request');
  });

  it('does not close the winning backend session when a stale completion has the same ID', async () => {
    let releaseSlow!: () => void;
    let releaseFast!: () => void;
    const slowBarrier = new Promise<void>((resolve) => (releaseSlow = resolve));
    const fastBarrier = new Promise<void>((resolve) => (releaseFast = resolve));
    let call = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== 'select_folder_session') return undefined as never;
      call += 1;
      await (call === 1 ? slowBarrier : fastBarrier);
      return {
        session_id: 'sess_shared',
        canonical_folder: 'c:/shared',
        images: [],
      } as never;
    });

    const slow = selectFolderSession();
    const fast = selectFolderSession();
    releaseFast();
    await expect(fast).resolves.toMatchObject({ session_id: 'sess_shared' });
    releaseSlow();
    await expect(slow).rejects.toThrow('superseded by a newer request');

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('close_folder_session', {
      sessionId: 'sess_shared',
    });
    expect(sessionCoordinator.getActiveSessionId()).toBe('sess_shared');
  });

  it('rejects raw folders that were not granted by a trusted native flow', async () => {
    await expect(openFolderSession('C:/Photos')).rejects.toThrow('No trusted native selection');
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('open_folder_session', expect.anything());
  });

  it('rescans an authorized folder through backend IPC for add remove rename and replacement', async () => {
    const { scanFolder } = await import('./tauriCommands');
    const records = [
      [{ id: 'img_a', sessionId: 'sess_refresh', path: 'C:/Photos/a.jpg', file_name: 'a.jpg' }],
      [
        { id: 'img_a', sessionId: 'sess_refresh', path: 'C:/Photos/a.jpg', file_name: 'a.jpg' },
        { id: 'img_b', sessionId: 'sess_refresh', path: 'C:/Photos/b.jpg', file_name: 'b.jpg' },
      ],
      [{ id: 'img_b', sessionId: 'sess_refresh', path: 'C:/Photos/b.jpg', file_name: 'b.jpg' }],
      [
        {
          id: 'img_b',
          sessionId: 'sess_refresh',
          path: 'C:/Photos/renamed.jpg',
          file_name: 'renamed.jpg',
        },
      ],
      [
        {
          id: 'img_new',
          sessionId: 'sess_refresh',
          path: 'C:/Photos/renamed.jpg',
          file_name: 'renamed.jpg',
        },
      ],
    ];
    let refresh = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'select_folder_session') {
        return {
          session_id: 'sess_refresh',
          session_instance_id: 'instance_refresh',
          canonical_folder: 'C:/Photos',
          images: [],
        } as never;
      }
      if (command === 'read_folder_index_by_session') {
        return records[refresh++] as never;
      }
      return undefined as never;
    });
    await selectFolderSession();

    await expect(scanFolder('C:/Photos')).resolves.toMatchObject([{ id: 'img_a' }]);
    await expect(scanFolder('C:/Photos')).resolves.toHaveLength(2);
    await expect(scanFolder('C:/Photos')).resolves.toMatchObject([{ id: 'img_b' }]);
    await expect(scanFolder('C:/Photos')).resolves.toMatchObject([
      { id: 'img_b', path: 'C:/Photos/renamed.jpg' },
    ]);
    await expect(scanFolder('C:/Photos')).resolves.toMatchObject([
      { id: 'img_new', path: 'C:/Photos/renamed.jpg' },
    ]);
    expect(sessionCoordinator.getActiveSessionForPath('C:/Photos/renamed.jpg')).toEqual({
      sessionId: 'sess_refresh',
      imageId: 'img_new',
    });
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === 'read_folder_index_by_session')
    ).toHaveLength(5);
  });

  it.each(['post-first', 'pre-first'] as const)(
    'keeps pre-reset native selections stale when completions are %s',
    async (completionOrder) => {
      let resolvePre!: () => void;
      let resolvePost!: () => void;
      const preBarrier = new Promise<void>((resolve) => (resolvePre = resolve));
      const postBarrier = new Promise<void>((resolve) => (resolvePost = resolve));
      let call = 0;
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command !== 'select_folder_session') return undefined as never;
        call += 1;
        if (call === 1) {
          await preBarrier;
          return {
            session_id: 'sess_pre_reset',
            canonical_folder: 'c:/pre',
            images: [],
          } as never;
        }
        await postBarrier;
        return {
          session_id: 'sess_post_reset',
          canonical_folder: 'c:/post',
          images: [],
        } as never;
      });

      const preReset = selectFolderSession();
      sessionCoordinator.reset();
      const postReset = selectFolderSession();
      if (completionOrder === 'post-first') {
        resolvePost();
        await postReset;
        resolvePre();
      } else {
        resolvePre();
      }
      await expect(preReset).rejects.toThrow('superseded by a newer request');
      resolvePost();
      await expect(postReset).resolves.toMatchObject({ session_id: 'sess_post_reset' });
      expect(sessionCoordinator.getActiveSessionId()).toBe('sess_post_reset');
    }
  );

  it('routes projector media facades through the adopted backend grant without opening a session', async () => {
    const { adoptProjectorGrant, getImageMetadata, getPreviewImage, getImageCaption } =
      await import('./tauriCommands');
    vi.mocked(invoke).mockResolvedValue({} as never);
    adoptProjectorGrant('sess_projector', { id: 'img_projector', path: 'C:/Photos/projected.jpg' });

    await getImageMetadata('C:/Photos/projected.jpg');
    await getPreviewImage('C:/Photos/projected.jpg', 2048);
    await getImageCaption('C:/Photos/projected.jpg');

    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(commands).toEqual([
      'get_image_metadata_by_id',
      'get_preview_image_by_id',
      'get_image_caption_by_id',
    ]);
    expect(commands).not.toContain('open_file_session');
  });
});

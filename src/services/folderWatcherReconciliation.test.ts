import { describe, expect, it } from 'vitest';
import { reconcileFolderWatcherPayload } from './folderWatcherReconciliation';
import type { ImageFile } from '../types/image';
import { pathIdentityKey } from './pathIdentity';

const image = (
  fileName: string,
  sizeBytes: number,
  modifiedAt: string | null = '100',
  id: string = `img_${fileName}`
): ImageFile => ({
  id,
  sessionId: 'session_1',
  path: `C:/images/${fileName}`,
  file_name: fileName,
  extension: fileName.split('.').pop() ?? '',
  size_bytes: sizeBytes,
  modified_at: modifiedAt,
});

describe('reconcileFolderWatcherPayload', () => {
  it('adds supported images using the active sort order', () => {
    const result = reconcileFolderWatcherPayload({
      payload: {
        sessionId: 'session_1',
        catalogRevision: 1,
        folderPath: 'C:/images',
        images: [image('image10.jpg', 10), image('image2.jpg', 2), image('image1.jpg', 1)],
        requiresFullRefresh: false,
        changes: [{ kind: 'added', path: 'C:/images/image2.jpg', image: image('image2.jpg', 2) }],
      },
      images: [image('image10.jpg', 10), image('image1.jpg', 1)],
      currentIndex: 0,
      currentImagePath: 'C:/images/image10.jpg',
      sortOrder: 'name',
    });

    expect(result.requiresFullRefresh).toBe(false);
    expect(result.images.map((item) => item.file_name)).toEqual([
      'image1.jpg',
      'image2.jpg',
      'image10.jpg',
    ]);
    expect(result.preferredPath).toBe('C:/images/image10.jpg');
    expect(result.preferredIndex).toBe(2);
  });

  it('removes deleted images and keeps nearest selection', () => {
    const result = reconcileFolderWatcherPayload({
      payload: {
        sessionId: 'session_1',
        catalogRevision: 1,
        folderPath: 'C:/images',
        images: [image('a.jpg', 1), image('b.jpg', 2)],
        requiresFullRefresh: false,
        changes: [{ kind: 'removed', path: 'C:/images/c.jpg' }],
      },
      images: [image('a.jpg', 1), image('b.jpg', 2), image('c.jpg', 3)],
      currentIndex: 2,
      currentImagePath: 'C:/images/c.jpg',
      sortOrder: 'name',
    });

    expect(result.images.map((item) => item.file_name)).toEqual(['a.jpg', 'b.jpg']);
    expect(result.invalidatedPaths).toEqual(['C:/images/c.jpg']);
    expect(result.preferredPath).toBeNull();
    expect(result.preferredIndex).toBe(1);
  });

  it('renames the current image while preserving selection', () => {
    const result = reconcileFolderWatcherPayload({
      payload: {
        sessionId: 'session_1',
        catalogRevision: 1,
        folderPath: 'C:/images',
        images: [image('a.jpg', 1), image('c.jpg', 3), image('d.jpg', 4, '100', 'img_b.jpg')],
        requiresFullRefresh: false,
        changes: [
          {
            kind: 'renamed',
            oldPath: 'C:/images/b.jpg',
            path: 'C:/images/d.jpg',
            image: image('d.jpg', 4, '100', 'img_b.jpg'),
          },
        ],
      },
      images: [image('a.jpg', 1), image('b.jpg', 2), image('c.jpg', 3)],
      currentIndex: 1,
      currentImagePath: 'C:/images/b.jpg',
      sortOrder: 'name',
    });

    expect(result.images.map((item) => item.file_name)).toEqual(['a.jpg', 'c.jpg', 'd.jpg']);
    expect(result.invalidatedPaths).toEqual(['C:/images/b.jpg', 'C:/images/d.jpg']);
    expect(result.preferredPath).toBe('C:/images/d.jpg');
    expect(result.preferredIndex).toBe(2);
  });

  it('invalidates and updates modified image records', () => {
    const result = reconcileFolderWatcherPayload({
      payload: {
        sessionId: 'session_1',
        catalogRevision: 1,
        folderPath: 'C:/images',
        images: [image('a.jpg', 42, '999'), image('b.jpg', 2)],
        requiresFullRefresh: false,
        changes: [
          {
            kind: 'modified',
            path: 'C:/images/a.jpg',
            image: image('a.jpg', 42, '999'),
          },
        ],
      },
      images: [image('a.jpg', 1), image('b.jpg', 2)],
      currentIndex: 0,
      currentImagePath: 'C:/images/a.jpg',
      sortOrder: 'name',
    });

    expect(result.invalidatedPaths).toEqual(['C:/images/a.jpg']);
    expect(result.images[0]).toMatchObject({
      file_name: 'a.jpg',
      size_bytes: 42,
      modified_at: '999',
    });
    expect(result.preferredPath).toBe('C:/images/a.jpg');
  });

  it('invalidates added paths so atomic replace saves do not keep stale assets', () => {
    const result = reconcileFolderWatcherPayload({
      payload: {
        sessionId: 'session_1',
        catalogRevision: 1,
        folderPath: 'C:/images',
        images: [image('a.jpg', 99, '999'), image('b.jpg', 2)],
        requiresFullRefresh: false,
        changes: [
          {
            kind: 'added',
            path: 'C:/images/a.jpg',
            image: image('a.jpg', 99, '999'),
          },
        ],
      },
      images: [image('a.jpg', 1), image('b.jpg', 2)],
      currentIndex: 0,
      currentImagePath: 'C:/images/a.jpg',
      sortOrder: 'name',
    });

    expect(result.invalidatedPaths).toEqual(['C:/images/a.jpg']);
    expect(result.images[0]).toMatchObject({
      file_name: 'a.jpg',
      size_bytes: 99,
      modified_at: '999',
    });
    expect(result.preferredPath).toBe('C:/images/a.jpg');
    expect(result.preferredIndex).toBe(0);
  });

  it('uses the supplied normalized catalog index for changed-path lookup', () => {
    const images = Array.from({ length: 10_000 }, (_, index) => image(`${index}.jpg`, index));
    const pathIndex = new Map(
      images.map((item, index) => [pathIdentityKey(item.path), BigInt(index) * 1_000_000n])
    );
    const result = reconcileFolderWatcherPayload({
      payload: {
        sessionId: 'session_1',
        catalogRevision: 1,
        folderPath: 'C:/images',
        images: images.filter((item) => item.file_name !== '5000.jpg'),
        requiresFullRefresh: false,
        changes: [{ kind: 'removed', path: 'C:/images/5000.jpg' }],
      },
      images,
      currentIndex: 5000,
      currentImagePath: 'C:/images/5000.jpg',
      sortOrder: 'name',
      pathIndex,
    });

    expect(result.images).toHaveLength(9_999);
    expect(pathIndex.has('c:/images/5000.jpg')).toBe(false);
    expect(pathIndex.get('c:/images/5001.jpg')).toBe(5_000_000_000n);
    expect(result.preferredPath).toBeNull();
  });

  it('uses a valid authoritative snapshot even for large batches', () => {
    const changes = Array.from({ length: 65 }, (_, index) => ({
      kind: 'modified' as const,
      path: `C:/images/${index}.jpg`,
      image: image(`${index}.jpg`, index),
    }));

    expect(
      reconcileFolderWatcherPayload({
        payload: {
          sessionId: 'session_1',
          catalogRevision: 1,
          folderPath: 'C:/images',
          images: changes.map((change) => change.image),
          requiresFullRefresh: false,
          changes,
        },
        images: [image('a.jpg', 1)],
        currentIndex: 0,
        currentImagePath: 'C:/images/a.jpg',
        sortOrder: 'name',
      }).requiresFullRefresh
    ).toBe(false);

    const invalid = image('invalid.jpg', 2);
    invalid.sessionId = 'another_session';
    expect(
      reconcileFolderWatcherPayload({
        payload: {
          sessionId: 'session_1',
          catalogRevision: 1,
          folderPath: 'C:/images',
          images: [invalid],
          requiresFullRefresh: true,
          changes: [],
        },
        images: [image('a.jpg', 1)],
        currentIndex: 0,
        currentImagePath: 'C:/images/a.jpg',
        sortOrder: 'name',
      }).requiresFullRefresh
    ).toBe(true);
  });
});

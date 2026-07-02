import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../types/settings';
import {
  getPersistedMarkedPathsForFolder,
  updatePersistedMarkedFolders,
} from './markedSelectionPersistence';

describe('markedSelectionPersistence', () => {
  it('returns persisted marks for the matching folder', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      persistedMarkedFolders: [
        {
          folderPath: 'C:/Images',
          markedPaths: ['C:/Images/a.jpg', 'C:/Images/b.jpg'],
          updatedAt: 1,
        },
      ],
    };

    expect(getPersistedMarkedPathsForFolder(settings, 'c:\\images')).toEqual([
      'C:/Images/a.jpg',
      'C:/Images/b.jpg',
    ]);
  });

  it('stores a deduplicated marked selection for the active folder', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const settings = { ...DEFAULT_SETTINGS, persistedMarkedFolders: [] };

    expect(
      updatePersistedMarkedFolders(settings, 'C:/Images', [
        'C:/Images/a.jpg',
        'c:\\images\\A.jpg',
        'C:/Images/b.jpg',
      ])
    ).toEqual([
      {
        folderPath: 'C:/Images',
        markedPaths: ['C:/Images/a.jpg', 'C:/Images/b.jpg'],
        updatedAt: 1234,
      },
    ]);
  });

  it('removes the persisted entry when the folder no longer has marks', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      persistedMarkedFolders: [
        {
          folderPath: 'C:/Images',
          markedPaths: ['C:/Images/a.jpg'],
          updatedAt: 1,
        },
      ],
    };

    expect(updatePersistedMarkedFolders(settings, 'C:/Images', [])).toEqual([]);
  });

  it('returns the same selection array when nothing changed', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      persistedMarkedFolders: [
        {
          folderPath: 'C:/Images',
          markedPaths: ['C:/Images/a.jpg'],
          updatedAt: 1,
        },
      ],
    };

    expect(updatePersistedMarkedFolders(settings, 'C:/Images', ['C:/Images/a.jpg'])).toBe(
      settings.persistedMarkedFolders
    );
  });
});

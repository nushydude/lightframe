import { create } from 'zustand';
import type { ImageCuration } from '../types/curation';
import {
  clearImageCuration as clearImageCurationCommand,
  readCurationMetadata,
  writeImageCuration,
  writeImageCurationBatch,
  type ImageCurationUpdate,
} from '../services/tauriCommands';

interface CurationState {
  curationByPath: Record<string, ImageCuration>;
  isLoaded: boolean;
  loadCuration: () => Promise<void>;
  toggleFavorite: (filePath: string) => Promise<void>;
  setRating: (filePath: string, rating: number) => Promise<void>;
  setFavoriteForPaths: (filePaths: string[], favorite: boolean) => Promise<void>;
  setRatingForPaths: (filePaths: string[], rating: number) => Promise<void>;
  clearImageCuration: (filePath: string) => Promise<void>;
}

function clampRating(rating: number): number {
  if (!Number.isFinite(rating)) {
    return 0;
  }
  return Math.max(0, Math.min(5, Math.round(rating)));
}

function buildEntry(filePath: string, favorite: boolean, rating: number): ImageCuration {
  return {
    path: filePath,
    favorite,
    rating: clampRating(rating),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function shouldPersist(favorite: boolean, rating: number): boolean {
  return favorite || clampRating(rating) > 0;
}

function shouldPromoteRatingToFavorite(rating: number): boolean {
  return clampRating(rating) >= 4;
}

function uniqueValidPaths(filePaths: string[]): string[] {
  return Array.from(new Set(filePaths.map((path) => path.trim()).filter(Boolean)));
}

let curationMutationQueue: Promise<void> = Promise.resolve();

function enqueueCurationMutation(work: () => Promise<void>): Promise<void> {
  const run = curationMutationQueue.catch(() => undefined).then(work);
  curationMutationQueue = run.catch(() => undefined);
  return run;
}

function normalizeCuration(
  curationByPath: Record<string, ImageCuration>
): Record<string, ImageCuration> {
  const normalized: Record<string, ImageCuration> = {};

  for (const [key, value] of Object.entries(curationByPath)) {
    const normalizedPath = (value.path || key).trim();
    if (!normalizedPath) {
      continue;
    }

    const rating = clampRating(value.rating);
    const favorite = Boolean(value.favorite);
    if (!shouldPersist(favorite, rating)) {
      continue;
    }

    normalized[normalizedPath] = {
      path: normalizedPath,
      favorite,
      rating,
      updated_at: value.updated_at ?? Math.floor(Date.now() / 1000),
    };
  }

  return normalized;
}

export const useCurationStore = create<CurationState>((set, get) => ({
  curationByPath: {},
  isLoaded: false,

  loadCuration: async () => {
    try {
      const metadata = await readCurationMetadata();
      set({ curationByPath: normalizeCuration(metadata), isLoaded: true });
    } catch (err) {
      console.error('Failed to load curation metadata:', err);
      set({ curationByPath: {}, isLoaded: true });
    }
  },

  toggleFavorite: async (filePath) => {
    await enqueueCurationMutation(async () => {
      if (!filePath) {
        return;
      }

      const current = get().curationByPath[filePath];
      const nextFavorite = !current?.favorite;
      const currentRating = clampRating(current?.rating ?? 0);

      try {
        await writeImageCuration(filePath, nextFavorite, currentRating);
        set((state) => {
          const next = { ...state.curationByPath };
          if (shouldPersist(nextFavorite, currentRating)) {
            next[filePath] = buildEntry(filePath, nextFavorite, currentRating);
          } else {
            delete next[filePath];
          }
          return { curationByPath: next };
        });
      } catch (err) {
        console.error('Failed to toggle favorite:', err);
      }
    });
  },

  setRating: async (filePath, rating) => {
    await enqueueCurationMutation(async () => {
      if (!filePath) {
        return;
      }

      const normalizedRating = clampRating(rating);
      const current = get().curationByPath[filePath];
      const favorite =
        Boolean(current?.favorite) || shouldPromoteRatingToFavorite(normalizedRating);

      try {
        await writeImageCuration(filePath, favorite, normalizedRating);
        set((state) => {
          const next = { ...state.curationByPath };
          if (shouldPersist(favorite, normalizedRating)) {
            next[filePath] = buildEntry(filePath, favorite, normalizedRating);
          } else {
            delete next[filePath];
          }
          return { curationByPath: next };
        });
      } catch (err) {
        console.error('Failed to set rating:', err);
      }
    });
  },

  setFavoriteForPaths: async (filePaths, favorite) => {
    await enqueueCurationMutation(async () => {
      const paths = uniqueValidPaths(filePaths);
      if (paths.length === 0) {
        return;
      }

      const snapshot = get().curationByPath;
      const batchUpdates = paths.map((filePath): ImageCurationUpdate => {
        const currentRating = clampRating(snapshot[filePath]?.rating ?? 0);
        return { filePath, favorite, rating: currentRating };
      });

      try {
        await writeImageCurationBatch(batchUpdates);
        set((state) => {
          const next = { ...state.curationByPath };
          for (const update of batchUpdates) {
            const normalizedRating = clampRating(update.rating);
            if (shouldPersist(update.favorite, normalizedRating)) {
              next[update.filePath] = buildEntry(
                update.filePath,
                update.favorite,
                normalizedRating
              );
            } else {
              delete next[update.filePath];
            }
          }
          return { curationByPath: next };
        });
      } catch (err) {
        console.error('Failed to set favorite:', err);
      }
    });
  },

  setRatingForPaths: async (filePaths, rating) => {
    await enqueueCurationMutation(async () => {
      const paths = uniqueValidPaths(filePaths);
      if (paths.length === 0) {
        return;
      }

      const normalizedRating = clampRating(rating);
      const snapshot = get().curationByPath;
      const batchUpdates = paths.map((filePath): ImageCurationUpdate => {
        const favorite =
          Boolean(snapshot[filePath]?.favorite) || shouldPromoteRatingToFavorite(normalizedRating);
        return { filePath, favorite, rating: normalizedRating };
      });

      try {
        await writeImageCurationBatch(batchUpdates);
        set((state) => {
          const next = { ...state.curationByPath };
          for (const update of batchUpdates) {
            const normalizedUpdateRating = clampRating(update.rating);
            if (shouldPersist(update.favorite, normalizedUpdateRating)) {
              next[update.filePath] = buildEntry(
                update.filePath,
                update.favorite,
                normalizedUpdateRating
              );
            } else {
              delete next[update.filePath];
            }
          }
          return { curationByPath: next };
        });
      } catch (err) {
        console.error('Failed to set rating:', err);
      }
    });
  },

  clearImageCuration: async (filePath) => {
    await enqueueCurationMutation(async () => {
      if (!filePath) {
        return;
      }

      try {
        await clearImageCurationCommand(filePath);
        set((state) => {
          const next = { ...state.curationByPath };
          delete next[filePath];
          return { curationByPath: next };
        });
      } catch (err) {
        console.error('Failed to clear curation metadata:', err);
      }
    });
  },
}));

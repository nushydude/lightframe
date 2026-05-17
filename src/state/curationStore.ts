import { create } from 'zustand';
import type { ImageCuration } from '../types/curation';
import {
  clearImageCuration as clearImageCurationCommand,
  readCurationMetadata,
  writeImageCuration,
} from '../services/tauriCommands';

interface CurationState {
  curationByPath: Record<string, ImageCuration>;
  isLoaded: boolean;
  loadCuration: () => Promise<void>;
  toggleFavorite: (filePath: string) => Promise<void>;
  setRating: (filePath: string, rating: number) => Promise<void>;
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
  },

  setRating: async (filePath, rating) => {
    if (!filePath) {
      return;
    }

    const normalizedRating = clampRating(rating);
    const current = get().curationByPath[filePath];
    const favorite = Boolean(current?.favorite) || shouldPromoteRatingToFavorite(normalizedRating);

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
  },

  clearImageCuration: async (filePath) => {
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
  },
}));

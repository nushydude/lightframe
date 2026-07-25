import { create } from 'zustand';
import type { ImageCuration } from '../types/curation';
import {
  clearImageCuration as clearImageCurationCommand,
  readCurationMetadata,
  readCurationMetadataForPaths,
  writeImageCuration,
  writeImageCurationBatch,
  type ImageCurationUpdate,
} from '../services/tauriCommands';

export type CurationIntent =
  | { kind: 'toggleFavorite'; filePath: string }
  | { kind: 'setRating'; filePath: string; rating: number }
  | { kind: 'setFavoriteForPaths'; filePaths: string[]; favorite: boolean }
  | { kind: 'setRatingForPaths'; filePaths: string[]; rating: number }
  | { kind: 'clear'; filePath: string };

type CurationLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';
type CurationMutationStatus = 'idle' | 'saving' | 'error';

export class CurationPersistenceError extends Error {
  readonly intent: CurationIntent;

  constructor(message: string, intent: CurationIntent) {
    super(message);
    this.name = 'CurationPersistenceError';
    this.intent = intent;
  }
}

interface CurationState {
  curationByPath: Record<string, ImageCuration>;
  curationIndex: CurationIndex;
  curationView: Record<string, ImageCuration>;
  favoritePaths: Set<string>;
  isLoaded: boolean;
  loadStatus: CurationLoadStatus;
  loadError: string | null;
  mutationStatus: CurationMutationStatus;
  mutationError: string | null;
  mutationRevision: number;
  failedOperation: { intent: CurationIntent; revision: number } | null;
  errorDismissed: boolean;
  loadCuration: (filePaths?: string[]) => Promise<void>;
  toggleFavorite: (filePath: string) => Promise<void>;
  setRating: (filePath: string, rating: number) => Promise<void>;
  setFavoriteForPaths: (filePaths: string[], favorite: boolean) => Promise<void>;
  setRatingForPaths: (filePaths: string[], rating: number) => Promise<void>;
  clearImageCuration: (filePath: string) => Promise<void>;
  retryLastFailedOperation: () => Promise<void>;
  dismissError: () => void;
}

type CurationIndex = {
  entries: Map<string, ImageCuration>;
  pathsByKey: Map<string, string>;
};

function normalizePathKey(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

function createCurationIndex(entries: Record<string, ImageCuration>): CurationIndex {
  const index: CurationIndex = { entries: new Map(), pathsByKey: new Map() };
  for (const [key, value] of Object.entries(entries)) {
    const path = (value.path || key).trim();
    if (!path) continue;
    index.entries.set(path, value);
    index.pathsByKey.set(normalizePathKey(path), path);
  }
  return index;
}

function curationIndexEntry(index: CurationIndex, path: string): ImageCuration | undefined {
  const canonicalPath = index.pathsByKey.get(normalizePathKey(path));
  return canonicalPath ? index.entries.get(canonicalPath) : undefined;
}

function setCurationIndexEntry(
  index: CurationIndex,
  path: string,
  entry: ImageCuration | null
): void {
  const key = normalizePathKey(path);
  const previousPath = index.pathsByKey.get(key);
  if (previousPath) index.entries.delete(previousPath);
  index.pathsByKey.delete(key);
  if (entry) {
    index.entries.set(entry.path, entry);
    index.pathsByKey.set(key, entry.path);
  }
}

function createCurationView(index: CurationIndex): Record<string, ImageCuration> {
  return new Proxy(Object.create(null) as Record<string, ImageCuration>, {
    get: (_target, property: string | symbol) =>
      typeof property === 'string' ? curationIndexEntry(index, property) : undefined,
    has: (_target, property: string | symbol) =>
      typeof property === 'string' && index.pathsByKey.has(normalizePathKey(property)),
    ownKeys: () => Array.from(index.entries.keys()),
    getOwnPropertyDescriptor: (_target, property: string | symbol) =>
      typeof property === 'string' && index.entries.has(property)
        ? { enumerable: true, configurable: true }
        : undefined,
  });
}

function clampRating(rating: number): number {
  if (!Number.isFinite(rating)) return 0;
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

function normalizeCurationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Curation changes could not be saved.';
}

let curationMutationQueue: Promise<void> = Promise.resolve();
let nextMutationRevision = 0;
let nextLoadRevision = 0;

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
    if (!normalizedPath) continue;
    const rating = clampRating(value.rating);
    const favorite = Boolean(value.favorite);
    if (!shouldPersist(favorite, rating)) continue;
    normalized[normalizedPath] = {
      path: normalizedPath,
      favorite,
      rating,
      updated_at: value.updated_at ?? Math.floor(Date.now() / 1000),
    };
  }
  return normalized;
}

function buildFavoritePathIndex(curationByPath: Record<string, ImageCuration>): Set<string> {
  return new Set(
    Object.entries(curationByPath).flatMap(([path, entry]) => (entry.favorite ? [path] : []))
  );
}

function getMutableCurationIndex(state: CurationState): CurationIndex {
  if (state.curationView !== state.curationByPath) {
    state.curationIndex = createCurationIndex(state.curationByPath);
    state.curationView = state.curationByPath;
  }
  return state.curationIndex;
}

function applyLocalUpdates(
  set: (updater: (state: CurationState) => Partial<CurationState>) => void,
  updates: Array<{ filePath: string; favorite: boolean; rating: number }>
): void {
  set((state) => {
    const index = getMutableCurationIndex(state);
    for (const update of updates) {
      const nextEntry = shouldPersist(update.favorite, update.rating)
        ? buildEntry(update.filePath, update.favorite, update.rating)
        : null;
      setCurationIndexEntry(index, update.filePath, nextEntry);
      const favoritePath = nextEntry?.path ?? update.filePath;
      if (update.favorite) state.favoritePaths.add(favoritePath);
      else state.favoritePaths.delete(favoritePath);
    }
    const view = createCurationView(index);
    return { curationByPath: view, curationView: view, favoritePaths: state.favoritePaths };
  });
}

function mergeScopedCuration(
  state: CurationState,
  normalized: Record<string, ImageCuration>,
  filePaths: string[]
): Record<string, ImageCuration> {
  const index = getMutableCurationIndex(state);
  for (const filePath of uniqueValidPaths(filePaths)) {
    const current = curationIndexEntry(index, filePath);
    setCurationIndexEntry(index, filePath, null);
    if (current?.favorite) state.favoritePaths.delete(current.path);
  }
  for (const entry of Object.values(normalized)) {
    setCurationIndexEntry(index, entry.path, entry);
    if (entry.favorite) state.favoritePaths.add(entry.path);
  }
  const view = createCurationView(index);
  state.curationView = view;
  state.curationByPath = view;
  return view;
}

function commitLoadedCuration(
  set: (partial: Partial<CurationState>) => void,
  get: () => CurationState,
  normalized: Record<string, ImageCuration>,
  filePaths?: string[]
): void {
  if (filePaths && filePaths.length > 0) {
    const state = get();
    const view = mergeScopedCuration(state, normalized, filePaths);
    set({ curationByPath: view, curationView: view });
    return;
  }
  const index = createCurationIndex(normalized);
  const view = createCurationView(index);
  set({
    curationByPath: view,
    curationIndex: index,
    curationView: view,
    favoritePaths: buildFavoritePathIndex(normalized),
  });
}

export const useCurationStore = create<CurationState>((set, get) => {
  const beginMutation = (): number => {
    const revision = ++nextMutationRevision;
    set({
      mutationStatus: 'saving',
      mutationError: null,
      mutationRevision: revision,
      failedOperation: null,
      errorDismissed: false,
    });
    return revision;
  };

  const executeMutation = async (intent: CurationIntent, revision: number): Promise<void> => {
    try {
      if (intent.kind === 'toggleFavorite') {
        const current = curationIndexEntry(getMutableCurationIndex(get()), intent.filePath);
        const favorite = !current?.favorite;
        const rating = clampRating(current?.rating ?? 0);
        await writeImageCuration(intent.filePath, favorite, rating);
        applyLocalUpdates(set, [{ filePath: intent.filePath, favorite, rating }]);
      } else if (intent.kind === 'setRating') {
        const current = curationIndexEntry(getMutableCurationIndex(get()), intent.filePath);
        const rating = clampRating(intent.rating);
        const favorite = Boolean(current?.favorite) || shouldPromoteRatingToFavorite(rating);
        await writeImageCuration(intent.filePath, favorite, rating);
        applyLocalUpdates(set, [{ filePath: intent.filePath, favorite, rating }]);
      } else if (intent.kind === 'clear') {
        await clearImageCurationCommand(intent.filePath);
        applyLocalUpdates(set, [{ filePath: intent.filePath, favorite: false, rating: 0 }]);
      } else {
        const paths = uniqueValidPaths(intent.filePaths);
        const index = getMutableCurationIndex(get());
        const batchUpdates: ImageCurationUpdate[] = paths.map((filePath) => {
          const current = curationIndexEntry(index, filePath);
          const currentRating = clampRating(current?.rating ?? 0);
          const rating =
            intent.kind === 'setFavoriteForPaths' ? currentRating : clampRating(intent.rating);
          const favorite =
            intent.kind === 'setFavoriteForPaths'
              ? intent.favorite
              : Boolean(current?.favorite) || shouldPromoteRatingToFavorite(rating);
          return { filePath, favorite, rating };
        });
        await writeImageCurationBatch(batchUpdates);
        applyLocalUpdates(set, batchUpdates);
      }

      if (get().mutationRevision === revision) {
        set({
          mutationStatus: 'idle',
          mutationError: null,
          failedOperation: null,
          errorDismissed: false,
        });
      }
    } catch (error) {
      const message = normalizeCurationError(error);
      if (get().mutationRevision === revision) {
        set({
          mutationStatus: 'error',
          mutationError: message,
          failedOperation: { intent, revision },
          errorDismissed: false,
        });
      }
      throw new CurationPersistenceError(message, intent);
    }
  };

  const enqueueIntent = (intent: CurationIntent): Promise<void> => {
    if (
      intent.kind === 'toggleFavorite' ||
      intent.kind === 'setRating' ||
      intent.kind === 'clear'
    ) {
      if (!intent.filePath) return Promise.resolve();
    } else if (uniqueValidPaths(intent.filePaths).length === 0) {
      return Promise.resolve();
    }
    const revision = beginMutation();
    return enqueueCurationMutation(() => executeMutation(intent, revision));
  };

  return {
    curationByPath: {},
    curationIndex: createCurationIndex({}),
    curationView: {},
    favoritePaths: new Set(),
    isLoaded: false,
    loadStatus: 'idle',
    loadError: null,
    mutationStatus: 'idle',
    mutationError: null,
    mutationRevision: 0,
    failedOperation: null,
    errorDismissed: false,

    loadCuration: async (filePaths) => {
      const revision = ++nextLoadRevision;
      set({ loadStatus: 'loading', loadError: null, errorDismissed: false });
      try {
        const metadata =
          filePaths && filePaths.length > 0
            ? await readCurationMetadataForPaths(filePaths)
            : await readCurationMetadata();
        if (revision === nextLoadRevision) {
          const normalized = normalizeCuration(metadata);
          commitLoadedCuration(set, get, normalized, filePaths);
          set({ isLoaded: true, loadStatus: 'loaded' });
        }
      } catch (error) {
        const message = normalizeCurationError(error);
        if (revision === nextLoadRevision) {
          if (filePaths && filePaths.length > 0) {
            set({ isLoaded: true, loadStatus: 'error', loadError: message });
          } else {
            set({
              curationByPath: {},
              curationIndex: createCurationIndex({}),
              curationView: {},
              favoritePaths: new Set(),
              isLoaded: true,
              loadStatus: 'error',
              loadError: message,
            });
          }
        }
        throw error;
      }
    },

    toggleFavorite: (filePath) => enqueueIntent({ kind: 'toggleFavorite', filePath }),
    setRating: (filePath, rating) => enqueueIntent({ kind: 'setRating', filePath, rating }),
    setFavoriteForPaths: (filePaths, favorite) =>
      enqueueIntent({ kind: 'setFavoriteForPaths', filePaths, favorite }),
    setRatingForPaths: (filePaths, rating) =>
      enqueueIntent({ kind: 'setRatingForPaths', filePaths, rating }),
    clearImageCuration: (filePath) => enqueueIntent({ kind: 'clear', filePath }),

    retryLastFailedOperation: () => {
      const failedOperation = get().failedOperation;
      if (!failedOperation) return Promise.resolve();
      return enqueueIntent(failedOperation.intent);
    },

    dismissError: () => set({ errorDismissed: true }),
  };
});

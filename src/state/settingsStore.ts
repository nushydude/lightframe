import { create } from 'zustand';
import type { AppSettings } from '../types/settings';
import { DEFAULT_SETTINGS } from '../types/settings';
import { readSettings, writeSettings } from '../services/tauriCommands';

interface SettingsState {
  settings: AppSettings;
  isLoaded: boolean;
  saveStatus: 'idle' | 'saving' | 'error';
  saveError: string | null;
  loadError: string | null;
  loadSettings: () => Promise<void>;
  retrySaveSettings: () => Promise<boolean>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<boolean>;
}

let settingsWriteQueue: Promise<void> = Promise.resolve();
let latestWriteRevision = 0;

function queueSettingsWrite(settings: AppSettings): Promise<void> {
  const pendingWrite = settingsWriteQueue
    .catch(() => undefined)
    .then(() => writeSettings(settings));
  settingsWriteQueue = pendingWrite;
  return pendingWrite;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isLoaded: false,
  saveStatus: 'idle',
  saveError: null,
  loadError: null,

  loadSettings: async () => {
    try {
      const settings = await readSettings();
      set({ settings, isLoaded: true, loadError: null });
    } catch (err) {
      console.error('Failed to load settings:', err);
      set({ isLoaded: true, loadError: normalizeSettingsError(err) }); // Use defaults
    }
  },

  updateSettings: async (partial) => {
    let updated = get().settings;
    set((state) => {
      updated = { ...state.settings, ...partial };
      return { settings: updated, saveStatus: 'saving', saveError: null };
    });

    const revision = ++latestWriteRevision;
    try {
      await queueSettingsWrite(updated);
      if (revision === latestWriteRevision) {
        set({ saveStatus: 'idle', saveError: null });
      }
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      if (revision === latestWriteRevision) {
        set({ saveStatus: 'error', saveError: normalizeSettingsError(err) });
      }
      return false;
    }
  },

  retrySaveSettings: async () => {
    const revision = ++latestWriteRevision;
    set({ saveStatus: 'saving', saveError: null });
    try {
      await queueSettingsWrite(get().settings);
      if (revision === latestWriteRevision) {
        set({ saveStatus: 'idle', saveError: null });
      }
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      if (revision === latestWriteRevision) {
        set({ saveStatus: 'error', saveError: normalizeSettingsError(err) });
      }
      return false;
    }
  },
}));

function normalizeSettingsError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return 'Unknown error';
}

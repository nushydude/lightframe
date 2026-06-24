import { create } from 'zustand';
import type { AppSettings } from '../types/settings';
import { DEFAULT_SETTINGS } from '../types/settings';
import { readSettings, writeSettings } from '../services/tauriCommands';

interface SettingsState {
  settings: AppSettings;
  isLoaded: boolean;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
}

let settingsWriteQueue: Promise<void> = Promise.resolve();

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

  loadSettings: async () => {
    try {
      const settings = await readSettings();
      set({ settings, isLoaded: true });
    } catch (err) {
      console.error('Failed to load settings:', err);
      set({ isLoaded: true }); // Use defaults
    }
  },

  updateSettings: async (partial) => {
    let updated = get().settings;
    set((state) => {
      updated = { ...state.settings, ...partial };
      return { settings: updated };
    });
    try {
      await queueSettingsWrite(updated);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  },
}));

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
    const current = get().settings;
    const updated = { ...current, ...partial };
    set({ settings: updated });
    try {
      await writeSettings(updated);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  },
}));

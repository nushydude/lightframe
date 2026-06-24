import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { DEFAULT_SETTINGS } from '../types/settings';

const { readSettingsMock, writeSettingsMock } = vi.hoisted(() => ({
  readSettingsMock: vi.fn(),
  writeSettingsMock: vi.fn(),
}));

vi.mock('../services/tauriCommands', () => ({
  readSettings: readSettingsMock,
  writeSettings: writeSettingsMock,
}));

describe('settingsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      settings: DEFAULT_SETTINGS,
      isLoaded: false,
    });
  });

  it('serializes overlapping settings writes with merged state snapshots', async () => {
    let releaseFirstWrite!: () => void;
    writeSettingsMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          })
      )
      .mockResolvedValueOnce(undefined);

    const firstUpdate = useSettingsStore.getState().updateSettings({ theme: 'light' });
    const secondUpdate = useSettingsStore
      .getState()
      .updateSettings({ slideshowIntervalSeconds: 9 });

    expect(useSettingsStore.getState().settings.theme).toBe('light');
    expect(useSettingsStore.getState().settings.slideshowIntervalSeconds).toBe(9);
    await vi.waitFor(() => {
      expect(writeSettingsMock).toHaveBeenCalledTimes(1);
    });
    expect(writeSettingsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        theme: 'light',
        slideshowIntervalSeconds: DEFAULT_SETTINGS.slideshowIntervalSeconds,
      })
    );

    releaseFirstWrite();
    await Promise.all([firstUpdate, secondUpdate]);

    expect(writeSettingsMock).toHaveBeenCalledTimes(2);
    expect(writeSettingsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        theme: 'light',
        slideshowIntervalSeconds: 9,
      })
    );
  });
});

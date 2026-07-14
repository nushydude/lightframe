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
      saveStatus: 'idle',
      saveError: null,
      loadError: null,
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

  it('does not hide saving while an older write completes before a newer one', async () => {
    let releaseFirstWrite!: () => void;
    let releaseSecondWrite!: () => void;
    writeSettingsMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSecondWrite = resolve;
          })
      );

    const firstUpdate = useSettingsStore.getState().updateSettings({ theme: 'light' });
    const secondUpdate = useSettingsStore.getState().updateSettings({ theme: 'system' });
    await vi.waitFor(() => expect(writeSettingsMock).toHaveBeenCalledTimes(1));

    releaseFirstWrite();
    await vi.waitFor(() => expect(writeSettingsMock).toHaveBeenCalledTimes(2));
    expect(useSettingsStore.getState().saveStatus).toBe('saving');

    releaseSecondWrite();
    await Promise.all([firstUpdate, secondUpdate]);
    expect(useSettingsStore.getState().saveStatus).toBe('idle');
  });

  it('retains optimistic settings and exposes a recoverable save error', async () => {
    writeSettingsMock.mockRejectedValueOnce(new Error('disk full'));

    const result = await useSettingsStore.getState().updateSettings({ theme: 'light' });

    expect(result).toBe(false);
    expect(useSettingsStore.getState().settings.theme).toBe('light');
    expect(useSettingsStore.getState().saveStatus).toBe('error');
    expect(useSettingsStore.getState().saveError).toBe('disk full');
  });

  it('continues the queue after a rejection and retries the latest snapshot', async () => {
    writeSettingsMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    await expect(useSettingsStore.getState().updateSettings({ theme: 'light' })).resolves.toBe(
      false
    );
    await expect(
      useSettingsStore.getState().updateSettings({ slideshowIntervalSeconds: 9 })
    ).resolves.toBe(true);
    expect(writeSettingsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'light', slideshowIntervalSeconds: 9 })
    );

    writeSettingsMock
      .mockRejectedValueOnce(new Error('retry failure'))
      .mockResolvedValueOnce(undefined);
    await expect(useSettingsStore.getState().updateSettings({ theme: 'dark' })).resolves.toBe(
      false
    );
    await expect(useSettingsStore.getState().retrySaveSettings()).resolves.toBe(true);
    expect(writeSettingsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark', slideshowIntervalSeconds: 9 })
    );
    expect(useSettingsStore.getState().saveError).toBeNull();
    expect(useSettingsStore.getState().saveStatus).toBe('idle');
  });

  it('keeps defaults usable and exposes load errors', async () => {
    readSettingsMock.mockRejectedValueOnce(new Error('settings file unavailable'));

    await useSettingsStore.getState().loadSettings();

    expect(useSettingsStore.getState().isLoaded).toBe(true);
    expect(useSettingsStore.getState().settings).toBe(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().loadError).toBe('settings file unavailable');

    readSettingsMock.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, theme: 'light' });
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().loadError).toBeNull();
    expect(useSettingsStore.getState().settings.theme).toBe('light');
  });
});

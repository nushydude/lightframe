import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkUpdateChannel, updateChannelLabel } from './updateService';

describe('updateService', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('checks the selected update channel through the backend bridge', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      rid: 7,
      currentVersion: '8.2.2',
      version: '8.3.0-beta.1',
      body: 'Preview build',
      rawJson: {},
    });

    const update = await checkUpdateChannel('preview');

    expect(invoke).toHaveBeenCalledWith('check_update_channel', { channel: 'preview' });
    expect(update?.version).toBe('8.3.0-beta.1');
    expect(update?.body).toBe('Preview build');
  });

  it('returns null when the backend reports no update', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);

    await expect(checkUpdateChannel('stable')).resolves.toBeNull();
  });

  it('labels user-facing update channels', () => {
    expect(updateChannelLabel('stable')).toBe('Stable');
    expect(updateChannelLabel('preview')).toBe('Preview');
  });
});

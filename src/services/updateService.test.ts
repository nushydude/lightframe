import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeRuntime } from './runtime/runtime';
import { createTestRuntimeAdapter } from './runtime/testAdapter';
import {
  checkUpdateChannel as checkServiceUpdateChannel,
  updateChannelLabel,
} from './updateService';

describe('updateService', () => {
  beforeEach(() => {
    initializeRuntime(createTestRuntimeAdapter());
  });

  it('checks the selected update channel through the backend bridge', async () => {
    const checkUpdateChannel = vi.fn().mockResolvedValueOnce({
      version: '8.3.0-beta.1',
      body: 'Preview build',
      downloadAndInstall: vi.fn(),
    });
    initializeRuntime(createTestRuntimeAdapter({ checkUpdateChannel }));

    const update = await checkServiceUpdateChannel('preview');

    expect(checkUpdateChannel).toHaveBeenCalledWith('preview');
    expect(update?.version).toBe('8.3.0-beta.1');
    expect(update?.body).toBe('Preview build');
  });

  it('returns null when the backend reports no update', async () => {
    initializeRuntime(
      createTestRuntimeAdapter({ checkUpdateChannel: vi.fn().mockResolvedValueOnce(null) })
    );

    await expect(checkServiceUpdateChannel('stable')).resolves.toBeNull();
  });

  it('labels user-facing update channels', () => {
    expect(updateChannelLabel('stable')).toBe('Stable');
    expect(updateChannelLabel('preview')).toBe('Preview');
  });
});

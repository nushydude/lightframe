import { invoke } from '@tauri-apps/api/core';
import { Update } from '@tauri-apps/plugin-updater';
import type { UpdateChannel } from '../types/settings';

interface ChannelUpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
}

export function updateChannelLabel(channel: UpdateChannel): string {
  return channel === 'preview' ? 'Preview' : 'Stable';
}

export async function checkUpdateChannel(channel: UpdateChannel): Promise<Update | null> {
  const metadata = await invoke<ChannelUpdateMetadata | null>('check_update_channel', { channel });
  if (!metadata) {
    return null;
  }

  return new Update(metadata as ConstructorParameters<typeof Update>[0]);
}

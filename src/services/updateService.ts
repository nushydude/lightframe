import type { UpdateChannel } from '../types/settings';
import { getRuntime } from './runtime/runtime';
import type { RuntimeUpdate } from './runtime/types';

export function updateChannelLabel(channel: UpdateChannel): string {
  return channel === 'preview' ? 'Preview' : 'Stable';
}

export async function checkUpdateChannel(channel: UpdateChannel): Promise<RuntimeUpdate | null> {
  return getRuntime().checkUpdateChannel(channel);
}

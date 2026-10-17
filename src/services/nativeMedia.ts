import { invoke } from '@tauri-apps/api/core';
import type { ImageWorkPriority } from './imageWorkScheduler';

type NativePriority = Exclude<ImageWorkPriority, 'foreground-thumbnail'> | 'explicit-edit';

export interface MediaWorkContext {
  signal?: AbortSignal;
  priority?: ImageWorkPriority | 'explicit-edit';
  generationToken?: string | number;
}

export interface NativeMediaStats {
  capacity: number;
  queueDepth: number;
  running: number;
  queuedByClass: number[];
  runningByClass: number[];
  canceledQueued: number;
  canceledRunning: number;
  coalescedConsumers: number;
  queueWait: { sampleCount: number; p50Ms: number; p95Ms: number; maxMs: number };
  execution: { sampleCount: number; p50Ms: number; p95Ms: number; maxMs: number };
}

export function nativeMediaPriority(priority: MediaWorkContext['priority']): NativePriority {
  return priority === 'foreground-thumbnail'
    ? 'visible-thumbnail'
    : (priority ?? 'current-preview');
}

/** Keep physical work accounted for until native settlement, even after consumer cancellation. */
export async function invokeNativeMedia<T>(
  command: string,
  args: Record<string, unknown>,
  context: MediaWorkContext = {}
): Promise<T> {
  const { signal } = context;
  const abortError = () =>
    Object.assign(new Error('Native media request canceled'), { name: 'AbortError' });
  if (signal?.aborted) throw abortError();
  const requestId = crypto.randomUUID();
  const cancel = () => {
    void invoke('cancel_media_request', { requestId }).catch(() => {});
  };
  const result = invoke<T>(command, {
    ...args,
    request: {
      requestId,
      priority: nativeMediaPriority(context.priority),
      generationToken:
        context.generationToken == null ? undefined : String(context.generationToken),
    },
  });
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const value = await result;
    if (signal?.aborted) throw abortError();
    return value;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export function configureNativeMedia(capacity: number): Promise<void> {
  return invoke('configure_media_executor', {
    capacity: Number.isFinite(capacity) ? Math.min(4, Math.max(2, Math.floor(capacity))) : 2,
  });
}

export function getNativeMediaStats(): Promise<NativeMediaStats> {
  return invoke('get_media_executor_stats', {});
}

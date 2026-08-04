import { createBrowserDevelopmentAdapter } from './browserDevelopmentAdapter';
import { createTauriRuntimeAdapter } from './tauriRuntimeAdapter';
import type { RuntimeAdapter } from './types';

let activeRuntime: RuntimeAdapter | undefined;

export function detectBrowserDevelopmentRuntime(): boolean {
  return typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);
}

export function initializeRuntime(adapter?: RuntimeAdapter): RuntimeAdapter {
  activeRuntime =
    adapter ??
    (detectBrowserDevelopmentRuntime()
      ? createBrowserDevelopmentAdapter()
      : createTauriRuntimeAdapter());
  return activeRuntime;
}

export function getRuntime(): RuntimeAdapter {
  if (!activeRuntime) return initializeRuntime();
  return activeRuntime;
}

export function resetRuntimeForTests(): void {
  activeRuntime = undefined;
}

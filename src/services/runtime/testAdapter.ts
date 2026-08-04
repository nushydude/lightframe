import { createBrowserDevelopmentAdapter } from './browserDevelopmentAdapter';
import type { RuntimeAdapter } from './types';

/** Test builder avoids per-test mutation of global Tauri objects. */
export function createTestRuntimeAdapter(overrides: Partial<RuntimeAdapter> = {}): RuntimeAdapter {
  return { ...createBrowserDevelopmentAdapter(), ...overrides };
}

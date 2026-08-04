import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { useToastStore } from '../state/toastStore';
import { initializeRuntime, resetRuntimeForTests } from '../services/runtime/runtime';
import { createTestRuntimeAdapter } from '../services/runtime/testAdapter';

// Mock Tauri Core APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
  Resource: class MockResource {
    rid: number;

    constructor(rid: number) {
      this.rid = rid;
    }

    close = vi.fn(async () => undefined);
  },
  Channel: class MockChannel {
    onmessage?: (message: unknown) => void;
  },
}));

// Mock AudioContext for boundary beep
window.AudioContext = vi.fn().mockImplementation(() => ({
  createOscillator: vi.fn(() => ({
    frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    type: 'sine',
  })),
  createGain: vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  })),
  destination: {},
  currentTime: 0,
})) as any;

afterEach(() => {
  useToastStore.getState().clearToasts();
  resetRuntimeForTests();
  initializeRuntime(createTestRuntimeAdapter());
});

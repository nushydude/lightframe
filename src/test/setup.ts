import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { useToastStore } from '../state/toastStore';
import { configurePathCaseSemantics } from '../services/pathIdentity';
import { initializeRuntime, resetRuntimeForTests } from '../services/runtime/runtime';
import { createBrowserDevelopmentAdapter } from '../services/runtime/browserDevelopmentAdapter';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';

// The desktop test matrix executes Windows-oriented fixtures by default. Individual Linux/path
// semantics tests explicitly override this through the same runtime injection point.
configurePathCaseSemantics('case-insensitive');

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

// Mock Tauri Window APIs
const mockWindow = {
  setFullscreen: vi.fn(),
  setTitle: vi.fn(),
};
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => mockWindow),
  PhysicalPosition: class PhysicalPosition {
    constructor(
      public x: number,
      public y: number
    ) {}
  },
  PhysicalSize: class PhysicalSize {
    constructor(
      public width: number,
      public height: number
    ) {}
  },
  currentMonitor: vi.fn(() =>
    Promise.resolve({
      name: 'Mock Display',
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
    })
  ),
}));

// Mock Tauri Event APIs
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock Tauri Dialog APIs
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
  message: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}));

// Existing desktop-focused tests use one injected runtime bridge instead of ad hoc capability use.
const testRuntime = createBrowserDevelopmentAdapter();
resetRuntimeForTests();
initializeRuntime({
  ...testRuntime,
  window: {
    ...testRuntime.window,
    label: 'main',
    setFullscreen: mockWindow.setFullscreen,
    setTitle: mockWindow.setTitle,
  },
  listen: (event, handler) => listen(event, (payload) => handler(payload as never)),
  openFileOrFolder: (options) => open(options) as Promise<string | null>,
  openFolder: (options) => open({ directory: true, ...options }) as Promise<string | null>,
  confirm: (message, options) => confirm(message, options),
});

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
});

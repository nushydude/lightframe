import "@testing-library/jest-dom";
import { vi } from 'vitest';

// Mock Tauri Core APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

// Mock Tauri Window APIs
const mockWindow = {
  setFullscreen: vi.fn(),
  setTitle: vi.fn(),
};
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => mockWindow),
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

// Mock AudioContext for boundary beep
global.window.AudioContext = vi.fn().mockImplementation(() => ({
  createOscillator: vi.fn(() => ({
    frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    type: 'sine'
  })),
  createGain: vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  })),
  destination: {},
  currentTime: 0,
})) as any;

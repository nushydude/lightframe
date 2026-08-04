import type { RuntimeAdapter, RuntimeUnlisten, RuntimeWindow } from './types';

const unsupportedMessage = (operation: string) =>
  `Browser demo mode does not support ${operation}. Run "pnpm tauri dev" for native behavior.`;

const browserWindow: RuntimeWindow = {
  label: 'browser-demo',
  show: async () => undefined,
  setTitle: async (title) => {
    document.title = title;
  },
  setFullscreen: async () => {
    throw new Error(unsupportedMessage('native fullscreen control'));
  },
  isFullscreen: async () => false,
  isMinimized: async () => false,
  outerPosition: async () => ({ x: 0, y: 0 }),
  innerSize: async () => ({ width: window.innerWidth, height: window.innerHeight }),
  setPosition: async () => undefined,
  setSize: async () => undefined,
  onMoved: async () => () => undefined,
  onResized: async () => () => undefined,
  close: async () => undefined,
};

/**
 * Deliberately capability-free adapter. It owns no filesystem, process, updater, or
 * Tauri bridge access, making `pnpm dev` safe to use with synthetic data only.
 */
export function createBrowserDevelopmentAdapter(): RuntimeAdapter {
  const listeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
  return {
    kind: 'browser-development',
    window: browserWindow,
    async listen<T>(event: string, handler: (payload: T) => void | Promise<void>) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler as (payload: unknown) => void | Promise<void>);
      listeners.set(event, handlers);
      const unlisten: RuntimeUnlisten = () => handlers.delete(handler as never);
      return unlisten;
    },
    async emit<T>(event: string, payload?: T) {
      await Promise.all(
        [...(listeners.get(event) ?? new Set())].map((handler) => handler(payload))
      );
    },
    startupArguments: async () => ({}),
    openFileOrFolder: async () => null,
    openFolder: async () => null,
    confirm: async () => false,
    saveFile: async () => null,
    revealItem: async () => {
      throw new Error(unsupportedMessage('revealing files'));
    },
    openExternal: async () => {
      throw new Error(unsupportedMessage('opening external applications'));
    },
    relaunch: async () => {
      throw new Error(unsupportedMessage('restarting the application'));
    },
    checkUpdateChannel: async () => null,
    openSecondaryWindow: async () => {
      throw new Error(unsupportedMessage('projector windows'));
    },
    isSecondaryWindowOpen: async () => false,
    closeSecondaryWindow: async () => undefined,
    currentMonitor: async () => null,
    availableMonitors: async () => [],
    assetUrl: () => '',
    unsupported: async (operation) => {
      throw new Error(unsupportedMessage(operation));
    },
  };
}

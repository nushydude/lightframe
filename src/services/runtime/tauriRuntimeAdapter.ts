import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Update } from '@tauri-apps/plugin-updater';
import { open } from '@tauri-apps/plugin-dialog';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { relaunch } from '@tauri-apps/plugin-process';
import type { RuntimeAdapter, RuntimePosition, RuntimeSize } from './types';
import { projectorWindowTitle } from '../windowTitle';

export const projectorWindowOptions = () => ({
  title: projectorWindowTitle(),
  width: 800,
  height: 600,
  visible: false,
  focus: true,
});

type RuntimeMonitor = {
  name: string | null;
  position: RuntimePosition;
  size: RuntimeSize;
};

export function selectProjectorMonitor<T extends RuntimeMonitor>(
  monitors: T[],
  active: RuntimeMonitor | null
): T | null {
  if (monitors.length === 0) return null;
  if (monitors.length === 1) return monitors[0] ?? null;
  return monitors.find((monitor) => !sameMonitor(monitor, active)) ?? monitors[0] ?? null;
}

function sameMonitor(a: RuntimeMonitor, b: RuntimeMonitor | null): boolean {
  return (
    a.name === b?.name &&
    a.position.x === b?.position.x &&
    a.position.y === b?.position.y &&
    a.size.width === b?.size.width &&
    a.size.height === b?.size.height
  );
}

type NativeWindow = {
  label: string;
  show: () => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  setFullscreen: (fullscreen: boolean) => Promise<void>;
  isFullscreen: () => Promise<boolean>;
  isMinimized: () => Promise<boolean>;
  outerPosition: () => Promise<RuntimePosition>;
  innerSize: () => Promise<RuntimeSize>;
  setPosition: (position: PhysicalPosition) => Promise<void>;
  setSize: (size: PhysicalSize) => Promise<void>;
  onMoved: (handler: () => void) => Promise<() => void>;
  onResized: (handler: () => void) => Promise<() => void>;
  close: () => Promise<void>;
};

export function createTauriWindowAdapter(
  appWindow: NativeWindow,
  physical = {
    position: (position: RuntimePosition) => new PhysicalPosition(position.x, position.y),
    size: (size: RuntimeSize) => new PhysicalSize(size.width, size.height),
  }
): RuntimeAdapter['window'] {
  return {
    label: appWindow.label,
    show: () => appWindow.show(),
    setTitle: (title) => appWindow.setTitle(title),
    setFullscreen: (value) => appWindow.setFullscreen(value),
    isFullscreen: () => appWindow.isFullscreen(),
    isMinimized: () => appWindow.isMinimized(),
    outerPosition: () => appWindow.outerPosition(),
    innerSize: () => appWindow.innerSize(),
    setPosition: (position) => appWindow.setPosition(physical.position(position)),
    setSize: (size) => appWindow.setSize(physical.size(size)),
    onMoved: (handler) => appWindow.onMoved(handler),
    onResized: (handler) => appWindow.onResized(handler),
    close: () => appWindow.close(),
  };
}

async function projectorMonitor() {
  return selectProjectorMonitor(await availableMonitors(), await currentMonitor());
}

async function placeProjector(webview: WebviewWindow) {
  const monitor = await projectorMonitor();
  if (monitor) {
    await webview.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
    await webview.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
  }
  await webview.show();
  await webview.setFocus();
  await webview.setFullscreen(true);
}

type ProjectorCreationWindow = {
  once(event: string, handler: (event: { payload?: unknown }) => void): Promise<unknown>;
};

export function waitForProjectorCreation(webview: ProjectorCreationWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    void webview.once('tauri://created', () => resolve());
    void webview.once('tauri://error', (event) => {
      reject(event.payload instanceof Error ? event.payload : new Error(String(event.payload)));
    });
  });
}

/** Real desktop implementation. Tauri imports are intentionally contained in this module. */
export function createTauriRuntimeAdapter(): RuntimeAdapter {
  const appWindow = getCurrentWindow();
  return {
    kind: 'tauri',
    window: createTauriWindowAdapter(appWindow),
    listen: async (event, handler) =>
      listen(event, (received) => handler(received.payload as never)),
    emit,
    // Startup file selection is intentionally resolved by the Rust authority layer.  Keeping
    // this boundary method deterministic avoids a browser-only dependency on the CLI plugin.
    startupArguments: async () => ({}),
    openFileOrFolder: async (options) =>
      (await open({ multiple: false, ...options })) as string | null,
    openFolder: async (options) =>
      (await open({ directory: true, multiple: false, ...options })) as string | null,
    confirm: async (message, options) =>
      confirm(message, { title: options?.title ?? 'LightFrame', kind: options?.kind }),
    saveFile: async (defaultPath, options) =>
      (await save({ defaultPath, ...options })) as string | null,
    revealItem: revealItemInDir,
    openExternal: openUrl,
    relaunch,
    checkUpdateChannel: async (channel) => {
      const metadata = await invoke<Record<string, unknown> | null>('check_update_channel', {
        channel,
      });
      const update = metadata
        ? new Update(metadata as unknown as ConstructorParameters<typeof Update>[0])
        : null;
      return update
        ? {
            version: update.version,
            body: update.body,
            downloadAndInstall: (listener) => update.downloadAndInstall(listener),
          }
        : null;
    },
    openSecondaryWindow: async () => {
      const label = 'secondary';
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) return placeProjector(existing);
      const webview = new WebviewWindow(label, projectorWindowOptions());
      await waitForProjectorCreation(webview);
      await placeProjector(webview);
    },
    isSecondaryWindowOpen: async () => (await WebviewWindow.getByLabel('secondary')) !== null,
    closeSecondaryWindow: async () => {
      const webview = await WebviewWindow.getByLabel('secondary');
      if (!webview) return;
      try {
        await webview.setFullscreen(false);
      } catch (error) {
        console.warn('Failed to exit projector fullscreen before closing:', error);
      }
      await webview.close();
    },
    currentMonitor,
    availableMonitors,
    assetUrl: convertFileSrc,
    unsupported: async (operation) => {
      throw new Error(`Tauri runtime does not provide ${operation}`);
    },
  };
}

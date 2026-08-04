export type RuntimeUnlisten = () => void;

export interface RuntimeUpdate {
  version: string;
  body?: string;
  downloadAndInstall(
    onEvent: (event: {
      event: string;
      data?: { chunkLength?: number; contentLength?: number };
    }) => void
  ): Promise<void>;
}
export type RuntimeDialogOptions = {
  directory?: boolean;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
  defaultPath?: string;
};

export type RuntimeConfirmationOptions = {
  title?: string;
  kind?: 'info' | 'warning' | 'error';
};

export type RuntimePosition = { x: number; y: number };
export type RuntimeSize = { width: number; height: number };

export type RuntimeWindow = {
  label: string;
  show: () => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  setFullscreen: (fullscreen: boolean) => Promise<void>;
  isFullscreen: () => Promise<boolean>;
  isMinimized: () => Promise<boolean>;
  outerPosition: () => Promise<RuntimePosition>;
  innerSize: () => Promise<RuntimeSize>;
  setPosition: (position: RuntimePosition) => Promise<void>;
  setSize: (size: RuntimeSize) => Promise<void>;
  onMoved: (handler: () => void) => Promise<RuntimeUnlisten>;
  onResized: (handler: () => void) => Promise<RuntimeUnlisten>;
  close: () => Promise<void>;
};

/** The only browser/native seam used by application startup and lifecycle code. */
export interface RuntimeAdapter {
  readonly kind: 'tauri' | 'browser-development';
  readonly window: RuntimeWindow;
  listen<T>(event: string, handler: (payload: T) => void | Promise<void>): Promise<RuntimeUnlisten>;
  emit<T>(event: string, payload?: T): Promise<void>;
  startupArguments(): Promise<{ file?: string; folder?: string }>;
  openFileOrFolder(options?: RuntimeDialogOptions): Promise<string | null>;
  openFolder(options?: RuntimeDialogOptions): Promise<string | null>;
  confirm(message: string, options?: RuntimeConfirmationOptions): Promise<boolean>;
  saveFile(defaultPath?: string, options?: RuntimeDialogOptions): Promise<string | null>;
  revealItem(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  relaunch(): Promise<void>;
  checkUpdateChannel(channel: string): Promise<RuntimeUpdate | null>;
  openSecondaryWindow(): Promise<void>;
  isSecondaryWindowOpen(): Promise<boolean>;
  closeSecondaryWindow(): Promise<void>;
  currentMonitor(): Promise<{
    name: string | null;
    position: { x: number; y: number };
    size: { width: number; height: number };
    scaleFactor: number;
  } | null>;
  availableMonitors(): Promise<
    Array<{
      name: string | null;
      position: { x: number; y: number };
      size: { width: number; height: number };
      scaleFactor: number;
    }>
  >;
  assetUrl(path: string): string;
  unsupported(operation: string): Promise<never>;
}

import type { AppSettings } from '../types/settings';

export interface PersistedWindowBounds {
  windowX?: number;
  windowY?: number;
  windowWidth?: number;
  windowHeight?: number;
}

export function hasCompleteWindowBounds(
  settings: PersistedWindowBounds
): settings is Required<PersistedWindowBounds> {
  return (
    Number.isFinite(settings.windowX) &&
    Number.isFinite(settings.windowY) &&
    Number.isFinite(settings.windowWidth) &&
    Number.isFinite(settings.windowHeight)
  );
}

interface ShouldPersistWindowBoundsParams {
  settings: AppSettings;
  isMainWindow: boolean;
  isFullscreen: boolean;
  isMinimized: boolean;
}

export function shouldPersistWindowBounds({
  settings,
  isMainWindow,
  isFullscreen,
  isMinimized,
}: ShouldPersistWindowBoundsParams): boolean {
  return settings.rememberWindowBounds && isMainWindow && !isFullscreen && !isMinimized;
}

interface PersistWindowBoundsSafelyParams {
  isUnmounted: () => boolean;
  isSettingsLoaded: boolean;
  isMainWindow: boolean;
  settings: AppSettings;
  readWindowFlags: () => Promise<{ isFullscreen: boolean; isMinimized: boolean }>;
  readWindowBounds: () => Promise<{
    position: { x: number; y: number };
    size: { width: number; height: number };
  }>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
}

export async function persistWindowBoundsSafely({
  isUnmounted,
  isSettingsLoaded,
  isMainWindow,
  settings,
  readWindowFlags,
  readWindowBounds,
  updateSettings,
}: PersistWindowBoundsSafelyParams): Promise<void> {
  if (isUnmounted() || !isSettingsLoaded) return;

  const { isFullscreen, isMinimized } = await readWindowFlags();
  if (isUnmounted()) return;

  if (
    !shouldPersistWindowBounds({
      settings,
      isMainWindow,
      isFullscreen,
      isMinimized,
    })
  ) {
    return;
  }

  const { position, size } = await readWindowBounds();
  if (isUnmounted()) return;

  if (size.width <= 0 || size.height <= 0) return;

  if (
    settings.windowX === position.x &&
    settings.windowY === position.y &&
    settings.windowWidth === size.width &&
    settings.windowHeight === size.height
  ) {
    return;
  }

  if (isUnmounted()) return;
  await updateSettings({
    windowX: position.x,
    windowY: position.y,
    windowWidth: size.width,
    windowHeight: size.height,
  });
}

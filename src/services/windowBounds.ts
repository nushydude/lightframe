import type { AppSettings, WindowBounds } from '../types/settings';

export interface PersistedWindowBounds {
  windowX?: number;
  windowY?: number;
  windowWidth?: number;
  windowHeight?: number;
}

export interface DisplayIdentity {
  name: string | null;
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
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

export function windowBoundsFromLegacySettings(
  settings: PersistedWindowBounds
): WindowBounds | null {
  if (!hasCompleteWindowBounds(settings)) {
    return null;
  }

  return {
    x: settings.windowX,
    y: settings.windowY,
    width: settings.windowWidth,
    height: settings.windowHeight,
  };
}

export function displayKeyFromMonitor(monitor: DisplayIdentity | null): string | null {
  if (!monitor) {
    return null;
  }

  const name = monitor.name?.trim() || 'display';
  return [
    name.replace(/[^\w.-]+/g, '_'),
    `${monitor.position.x},${monitor.position.y}`,
    `${monitor.size.width}x${monitor.size.height}`,
    `scale-${monitor.scaleFactor}`,
  ].join('|');
}

export function windowBoundsForDisplay(
  settings: AppSettings,
  displayKey: string | null
): WindowBounds | null {
  if (displayKey && settings.windowBoundsByDisplay[displayKey]) {
    return settings.windowBoundsByDisplay[displayKey];
  }

  if (displayKey && Object.keys(settings.windowBoundsByDisplay).length > 0) {
    return null;
  }

  return windowBoundsFromLegacySettings(settings);
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
  readDisplayKey?: () => Promise<string | null>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
}

export async function persistWindowBoundsSafely({
  isUnmounted,
  isSettingsLoaded,
  isMainWindow,
  settings,
  readWindowFlags,
  readWindowBounds,
  readDisplayKey,
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

  const displayKey = readDisplayKey ? await readDisplayKey() : null;
  if (isUnmounted()) return;

  const nextBounds = {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };
  const existingDisplayBounds = displayKey ? settings.windowBoundsByDisplay[displayKey] : undefined;
  const displayBoundsChanged =
    displayKey !== null && !windowBoundsEqual(existingDisplayBounds, nextBounds);
  const nextBoundsByDisplay =
    displayBoundsChanged && displayKey !== null
      ? {
          ...settings.windowBoundsByDisplay,
          [displayKey]: nextBounds,
        }
      : settings.windowBoundsByDisplay;

  if (
    settings.windowX === position.x &&
    settings.windowY === position.y &&
    settings.windowWidth === size.width &&
    settings.windowHeight === size.height &&
    !displayBoundsChanged
  ) {
    return;
  }

  if (isUnmounted()) return;
  await updateSettings({
    windowX: position.x,
    windowY: position.y,
    windowWidth: size.width,
    windowHeight: size.height,
    windowBoundsByDisplay: nextBoundsByDisplay,
  });
}

function windowBoundsEqual(left: WindowBounds | undefined, right: WindowBounds): boolean {
  return (
    left?.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

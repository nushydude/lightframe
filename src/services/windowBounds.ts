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

function windowBoundsFromLegacySettings(settings: PersistedWindowBounds): WindowBounds | null {
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
  displayKey: string | null,
  availableDisplayKeys?: Iterable<string>
): WindowBounds | null {
  const allowedDisplayKeys = availableDisplayKeys ? new Set(availableDisplayKeys) : null;
  const lastDisplayKey = settings.lastWindowDisplayKey?.trim() || null;

  if (
    lastDisplayKey &&
    settings.windowBoundsByDisplay[lastDisplayKey] &&
    (!allowedDisplayKeys || allowedDisplayKeys.has(lastDisplayKey))
  ) {
    return settings.windowBoundsByDisplay[lastDisplayKey];
  }

  if (
    displayKey &&
    settings.windowBoundsByDisplay[displayKey] &&
    (!allowedDisplayKeys || allowedDisplayKeys.has(displayKey))
  ) {
    return settings.windowBoundsByDisplay[displayKey];
  }

  if (allowedDisplayKeys && Object.keys(settings.windowBoundsByDisplay).length > 0) {
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

  const canPersist = await canPersistWindowBounds({
    isUnmounted,
    isMainWindow,
    settings,
    readWindowFlags,
  });
  if (!canPersist) {
    return;
  }

  const nextState = await readNextWindowBoundsState({
    isUnmounted,
    settings,
    readWindowBounds,
    readDisplayKey,
  });
  if (!nextState || shouldSkipWindowBoundsUpdate(settings, nextState)) {
    return;
  }

  if (isUnmounted()) return;
  await updateSettings({
    windowX: nextState.bounds.x,
    windowY: nextState.bounds.y,
    windowWidth: nextState.bounds.width,
    windowHeight: nextState.bounds.height,
    lastWindowDisplayKey: nextState.displayKey ?? undefined,
    windowBoundsByDisplay: nextState.boundsByDisplay,
  });
}

async function canPersistWindowBounds({
  isUnmounted,
  isMainWindow,
  settings,
  readWindowFlags,
}: Pick<
  PersistWindowBoundsSafelyParams,
  'isUnmounted' | 'isMainWindow' | 'settings' | 'readWindowFlags'
>): Promise<boolean> {
  const { isFullscreen, isMinimized } = await readWindowFlags();
  if (isUnmounted()) {
    return false;
  }

  return shouldPersistWindowBounds({
    settings,
    isMainWindow,
    isFullscreen,
    isMinimized,
  });
}

interface NextWindowBoundsState {
  bounds: WindowBounds;
  displayKey: string | null;
  boundsByDisplay: Record<string, WindowBounds>;
}

async function readNextWindowBoundsState({
  isUnmounted,
  settings,
  readWindowBounds,
  readDisplayKey,
}: Pick<
  PersistWindowBoundsSafelyParams,
  'isUnmounted' | 'settings' | 'readWindowBounds' | 'readDisplayKey'
>): Promise<NextWindowBoundsState | null> {
  const { position, size } = await readWindowBounds();
  if (isUnmounted() || size.width <= 0 || size.height <= 0) {
    return null;
  }

  const displayKey = readDisplayKey ? await readDisplayKey() : null;
  if (isUnmounted()) {
    return null;
  }

  const bounds = {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };

  return {
    bounds,
    displayKey,
    boundsByDisplay: nextWindowBoundsByDisplay(settings.windowBoundsByDisplay, displayKey, bounds),
  };
}

function nextWindowBoundsByDisplay(
  currentBoundsByDisplay: Record<string, WindowBounds>,
  displayKey: string | null,
  nextBounds: WindowBounds
): Record<string, WindowBounds> {
  if (displayKey === null || windowBoundsEqual(currentBoundsByDisplay[displayKey], nextBounds)) {
    return currentBoundsByDisplay;
  }

  return {
    ...currentBoundsByDisplay,
    [displayKey]: nextBounds,
  };
}

function shouldSkipWindowBoundsUpdate(
  settings: PersistedWindowBounds &
    Pick<AppSettings, 'lastWindowDisplayKey' | 'windowBoundsByDisplay'>,
  nextState: NextWindowBoundsState
): boolean {
  return (
    settings.windowX === nextState.bounds.x &&
    settings.windowY === nextState.bounds.y &&
    settings.windowWidth === nextState.bounds.width &&
    settings.windowHeight === nextState.bounds.height &&
    (settings.lastWindowDisplayKey ?? null) === nextState.displayKey &&
    settings.windowBoundsByDisplay === nextState.boundsByDisplay
  );
}

function windowBoundsEqual(left: WindowBounds | undefined, right: WindowBounds): boolean {
  return (
    left?.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

import { isPerformanceMode } from '../services/performanceMode';

export interface QuickDestination {
  id: string;
  label: string;
  path: string;
}

export interface RecentFolder {
  path: string;
  label: string;
  openedAt: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PerformanceMode = 'fast' | 'balanced' | 'lowMemory';

export interface AppSettings {
  theme: 'system' | 'dark' | 'light';
  slideshowIntervalSeconds: number;
  loopSlideshow: boolean;
  shuffleSlideshow: boolean;
  autoFullscreenOnSlideshow: boolean;
  mouseWheelBehavior: 'zoom' | 'navigate';
  defaultFitMode: 'fit' | 'fill' | 'actual';
  rememberWindowBounds: boolean;
  windowX?: number;
  windowY?: number;
  windowWidth?: number;
  windowHeight?: number;
  windowBoundsByDisplay: Record<string, WindowBounds>;
  sortOrder: 'name' | 'date' | 'size' | 'random';
  showThumbnails: boolean;
  promptProjectorGridOnOpen: boolean;
  openProjectorInGridView: boolean;
  performanceMode: PerformanceMode;
  autoRefreshFolder: boolean;
  recentFolders: RecentFolder[];
  quickDestinations: QuickDestination[];
  externalEditorPath?: string;
  externalEditorLabel?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  slideshowIntervalSeconds: 4,
  loopSlideshow: false,
  shuffleSlideshow: false,
  autoFullscreenOnSlideshow: true,
  mouseWheelBehavior: 'zoom',
  defaultFitMode: 'fit',
  rememberWindowBounds: true,
  windowBoundsByDisplay: {},
  sortOrder: 'name',
  showThumbnails: true,
  promptProjectorGridOnOpen: true,
  openProjectorInGridView: false,
  performanceMode: 'balanced',
  autoRefreshFolder: true,
  recentFolders: [],
  quickDestinations: [],
};

const MAX_RECENT_FOLDERS = 12;

/** Convert frontend camelCase settings to Rust snake_case format */
export function settingsToRust(settings: AppSettings): Record<string, unknown> {
  return {
    theme: settings.theme,
    slideshow_interval_seconds: settings.slideshowIntervalSeconds,
    loop_slideshow: settings.loopSlideshow,
    shuffle_slideshow: settings.shuffleSlideshow,
    auto_fullscreen_on_slideshow: settings.autoFullscreenOnSlideshow,
    mouse_wheel_behavior: settings.mouseWheelBehavior,
    default_fit_mode: settings.defaultFitMode,
    remember_window_bounds: settings.rememberWindowBounds,
    window_x: settings.windowX,
    window_y: settings.windowY,
    window_width: settings.windowWidth,
    window_height: settings.windowHeight,
    window_bounds_by_display: settings.windowBoundsByDisplay,
    sort_order: settings.sortOrder,
    show_thumbnails: settings.showThumbnails,
    prompt_projector_grid_on_open: settings.promptProjectorGridOnOpen,
    open_projector_in_grid_view: settings.openProjectorInGridView,
    performance_mode: settings.performanceMode,
    auto_refresh_folder: settings.autoRefreshFolder,
    recent_folders: settings.recentFolders.map((folder) => ({
      path: folder.path,
      label: folder.label,
      opened_at: folder.openedAt,
    })),
    quick_destinations: settings.quickDestinations.map((destination) => ({
      id: destination.id,
      label: destination.label,
      path: destination.path,
    })),
    external_editor_path: settings.externalEditorPath,
    external_editor_label: settings.externalEditorLabel,
  };
}

/** Convert Rust snake_case settings to frontend camelCase format */
export function settingsFromRust(raw: Record<string, unknown>): AppSettings {
  return {
    theme: stringSetting(raw.theme, DEFAULT_SETTINGS.theme),
    slideshowIntervalSeconds: numberSetting(
      raw.slideshow_interval_seconds,
      DEFAULT_SETTINGS.slideshowIntervalSeconds
    ),
    loopSlideshow: booleanSetting(raw.loop_slideshow, DEFAULT_SETTINGS.loopSlideshow),
    shuffleSlideshow: booleanSetting(raw.shuffle_slideshow, DEFAULT_SETTINGS.shuffleSlideshow),
    autoFullscreenOnSlideshow: booleanSetting(
      raw.auto_fullscreen_on_slideshow,
      DEFAULT_SETTINGS.autoFullscreenOnSlideshow
    ),
    mouseWheelBehavior: stringSetting(
      raw.mouse_wheel_behavior,
      DEFAULT_SETTINGS.mouseWheelBehavior
    ),
    defaultFitMode: stringSetting(raw.default_fit_mode, DEFAULT_SETTINGS.defaultFitMode),
    rememberWindowBounds: booleanSetting(
      raw.remember_window_bounds,
      DEFAULT_SETTINGS.rememberWindowBounds
    ),
    windowX: raw.window_x as number | undefined,
    windowY: raw.window_y as number | undefined,
    windowWidth: raw.window_width as number | undefined,
    windowHeight: raw.window_height as number | undefined,
    windowBoundsByDisplay: parseWindowBoundsByDisplay(raw.window_bounds_by_display),
    sortOrder: stringSetting(raw.sort_order, DEFAULT_SETTINGS.sortOrder),
    showThumbnails: booleanSetting(raw.show_thumbnails, DEFAULT_SETTINGS.showThumbnails),
    promptProjectorGridOnOpen: booleanSetting(
      raw.prompt_projector_grid_on_open,
      DEFAULT_SETTINGS.promptProjectorGridOnOpen
    ),
    openProjectorInGridView: booleanSetting(
      raw.open_projector_in_grid_view,
      DEFAULT_SETTINGS.openProjectorInGridView
    ),
    performanceMode: isPerformanceMode(raw.performance_mode)
      ? raw.performance_mode
      : DEFAULT_SETTINGS.performanceMode,
    autoRefreshFolder: booleanSetting(raw.auto_refresh_folder, DEFAULT_SETTINGS.autoRefreshFolder),
    recentFolders: parseRecentFolders(raw.recent_folders),
    quickDestinations: parseQuickDestinations(raw.quick_destinations),
    externalEditorPath: optionalTrimmedString(raw.external_editor_path),
    externalEditorLabel: optionalTrimmedString(raw.external_editor_label),
  };
}

function stringSetting<T extends string>(value: unknown, fallback: T): T {
  return typeof value === 'string' && value.trim() ? (value as T) : fallback;
}

function numberSetting(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseQuickDestinations(raw: unknown): QuickDestination[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_SETTINGS.quickDestinations;
  }

  return raw
    .map((value) => {
      const destination = value as Record<string, unknown>;
      const id = String(destination.id ?? '').trim();
      const label = String(destination.label ?? '').trim();
      const path = String(destination.path ?? '').trim();
      if (!id || !label || !path) {
        return null;
      }
      return { id, label, path };
    })
    .filter((value): value is QuickDestination => value !== null);
}

function parseWindowBoundsByDisplay(raw: unknown): Record<string, WindowBounds> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_SETTINGS.windowBoundsByDisplay;
  }

  const parsed: Record<string, WindowBounds> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const bounds = value as Record<string, unknown>;
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      parsed[key] = { x, y, width, height };
    }
  }

  return parsed;
}

function parseRecentFolders(raw: unknown): RecentFolder[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_SETTINGS.recentFolders;
  }

  return raw
    .map((value) => {
      const folder = value as Record<string, unknown>;
      const path = String(folder.path ?? '').trim();
      const label = String(folder.label ?? '').trim() || folderLabelFromPath(path);
      const openedAt = Number(folder.opened_at ?? folder.openedAt ?? 0);
      if (!path || !Number.isFinite(openedAt)) {
        return null;
      }
      return { path, label, openedAt };
    })
    .filter((value): value is RecentFolder => value !== null)
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, MAX_RECENT_FOLDERS);
}

function folderLabelFromPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path;
}

export function rememberRecentFolder(
  settings: AppSettings,
  folderPath: string,
  openedAt = Date.now()
): RecentFolder[] {
  const normalizedPath = folderPath.trim();
  if (!normalizedPath) {
    return settings.recentFolders;
  }

  const normalizedKey = normalizedPath.replace(/\\/g, '/').toLowerCase();
  const nextFolder: RecentFolder = {
    path: normalizedPath,
    label: folderLabelFromPath(normalizedPath),
    openedAt,
  };

  return [
    nextFolder,
    ...settings.recentFolders.filter(
      (folder) => folder.path.replace(/\\/g, '/').toLowerCase() !== normalizedKey
    ),
  ].slice(0, MAX_RECENT_FOLDERS);
}

import { isPerformanceMode } from '../services/performanceMode';
import { isCurationFilter, type CurationFilter } from '../services/curationFilter';

export interface QuickDestination {
  id: string;
  label: string;
  path: string;
}

export type PinnableToolbarActionId =
  | 'refresh'
  | 'recent-folders'
  | 'reveal'
  | 'copy'
  | 'copy-path'
  | 'copy-to'
  | 'move-to'
  | 'edit'
  | 'delete'
  | 'projector'
  | 'info'
  | 'settings';

export interface RecentFolder {
  path: string;
  label: string;
  openedAt: number;
}

export interface PersistedMarkedFolder {
  folderPath: string;
  markedPaths: string[];
  updatedAt: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PerformanceMode = 'fast' | 'balanced' | 'lowMemory';
export type UpdateChannel = 'stable' | 'preview';
export type SlideshowDirection = 'forward' | 'reverse';

export interface AppSettings {
  theme: 'system' | 'dark' | 'light';
  slideshowIntervalSeconds: number;
  slideshowDirection: SlideshowDirection;
  loopSlideshow: boolean;
  shuffleSlideshow: boolean;
  autoFullscreenOnSlideshow: boolean;
  cropSaveMode: 'copy' | 'overwrite';
  mouseWheelBehavior: 'zoom' | 'navigate';
  defaultFitMode: 'fit' | 'fill' | 'actual';
  rememberWindowBounds: boolean;
  windowX?: number;
  windowY?: number;
  windowWidth?: number;
  windowHeight?: number;
  lastWindowDisplayKey?: string;
  windowBoundsByDisplay: Record<string, WindowBounds>;
  sortOrder: 'name' | 'date' | 'created' | 'modified' | 'size' | 'random';
  sortDirection: 'ascending' | 'descending';
  showThumbnails: boolean;
  showImageCaptions: boolean;
  promptProjectorGridOnOpen: boolean;
  openProjectorInGridView: boolean;
  performanceMode: PerformanceMode;
  autoRefreshFolder: boolean;
  updateChannel: UpdateChannel;
  savedViewPresets: CurationFilter[];
  recentFolders: RecentFolder[];
  quickDestinations: QuickDestination[];
  pinnedToolbarActions: PinnableToolbarActionId[];
  externalEditorPath?: string;
  externalEditorLabel?: string;
  persistedMarkedFolders: PersistedMarkedFolder[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  slideshowIntervalSeconds: 4,
  slideshowDirection: 'forward',
  loopSlideshow: false,
  shuffleSlideshow: false,
  autoFullscreenOnSlideshow: true,
  cropSaveMode: 'copy',
  mouseWheelBehavior: 'zoom',
  defaultFitMode: 'fit',
  rememberWindowBounds: true,
  windowBoundsByDisplay: {},
  sortOrder: 'name',
  sortDirection: 'ascending',
  showThumbnails: true,
  showImageCaptions: true,
  promptProjectorGridOnOpen: true,
  openProjectorInGridView: false,
  performanceMode: 'balanced',
  autoRefreshFolder: true,
  updateChannel: 'stable',
  savedViewPresets: ['favorites', 'rated4', 'unreviewed'],
  recentFolders: [],
  quickDestinations: [],
  pinnedToolbarActions: [],
  persistedMarkedFolders: [],
};

const MAX_RECENT_FOLDERS = 12;

/** Convert frontend camelCase settings to Rust snake_case format */
export function settingsToRust(settings: AppSettings): Record<string, unknown> {
  return {
    theme: settings.theme,
    slideshow_interval_seconds: settings.slideshowIntervalSeconds,
    slideshow_direction: settings.slideshowDirection,
    loop_slideshow: settings.loopSlideshow,
    shuffle_slideshow: settings.shuffleSlideshow,
    auto_fullscreen_on_slideshow: settings.autoFullscreenOnSlideshow,
    crop_save_mode: settings.cropSaveMode,
    mouse_wheel_behavior: settings.mouseWheelBehavior,
    default_fit_mode: settings.defaultFitMode,
    remember_window_bounds: settings.rememberWindowBounds,
    window_x: settings.windowX,
    window_y: settings.windowY,
    window_width: settings.windowWidth,
    window_height: settings.windowHeight,
    last_window_display_key: settings.lastWindowDisplayKey,
    window_bounds_by_display: settings.windowBoundsByDisplay,
    sort_order: settings.sortOrder,
    sort_direction: settings.sortDirection,
    show_thumbnails: settings.showThumbnails,
    show_image_captions: settings.showImageCaptions,
    prompt_projector_grid_on_open: settings.promptProjectorGridOnOpen,
    open_projector_in_grid_view: settings.openProjectorInGridView,
    performance_mode: settings.performanceMode,
    auto_refresh_folder: settings.autoRefreshFolder,
    update_channel: settings.updateChannel,
    saved_view_presets: settings.savedViewPresets,
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
    pinned_toolbar_actions: settings.pinnedToolbarActions,
    external_editor_path: settings.externalEditorPath,
    external_editor_label: settings.externalEditorLabel,
    persisted_marked_folders: settings.persistedMarkedFolders.map((folder) => ({
      folder_path: folder.folderPath,
      marked_paths: folder.markedPaths,
      updated_at: folder.updatedAt,
    })),
  };
}

/** Convert Rust snake_case settings to frontend camelCase format */
export function settingsFromRust(raw: Record<string, unknown>): AppSettings {
  return {
    theme: parseTheme(raw.theme),
    slideshowIntervalSeconds: numberSetting(
      raw.slideshow_interval_seconds,
      DEFAULT_SETTINGS.slideshowIntervalSeconds
    ),
    slideshowDirection: parseSlideshowDirection(raw.slideshow_direction),
    loopSlideshow: booleanSetting(raw.loop_slideshow, DEFAULT_SETTINGS.loopSlideshow),
    shuffleSlideshow: booleanSetting(raw.shuffle_slideshow, DEFAULT_SETTINGS.shuffleSlideshow),
    autoFullscreenOnSlideshow: booleanSetting(
      raw.auto_fullscreen_on_slideshow,
      DEFAULT_SETTINGS.autoFullscreenOnSlideshow
    ),
    cropSaveMode: parseCropSaveMode(raw.crop_save_mode),
    mouseWheelBehavior: parseMouseWheelBehavior(raw.mouse_wheel_behavior),
    defaultFitMode: parseDefaultFitMode(raw.default_fit_mode),
    rememberWindowBounds: booleanSetting(
      raw.remember_window_bounds,
      DEFAULT_SETTINGS.rememberWindowBounds
    ),
    windowX: finiteNumberSetting(raw.window_x),
    windowY: finiteNumberSetting(raw.window_y),
    windowWidth: positiveFiniteNumberSetting(raw.window_width),
    windowHeight: positiveFiniteNumberSetting(raw.window_height),
    lastWindowDisplayKey: optionalTrimmedString(raw.last_window_display_key),
    windowBoundsByDisplay: parseWindowBoundsByDisplay(raw.window_bounds_by_display),
    ...parseSortSettings(raw.sort_order, raw.sort_direction),
    showThumbnails: booleanSetting(raw.show_thumbnails, DEFAULT_SETTINGS.showThumbnails),
    showImageCaptions: booleanSetting(raw.show_image_captions, DEFAULT_SETTINGS.showImageCaptions),
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
    updateChannel: parseUpdateChannel(raw.update_channel),
    savedViewPresets: parseSavedViewPresets(raw.saved_view_presets),
    recentFolders: parseRecentFolders(raw.recent_folders),
    quickDestinations: parseQuickDestinations(raw.quick_destinations),
    pinnedToolbarActions: parsePinnedToolbarActions(raw.pinned_toolbar_actions),
    externalEditorPath: optionalTrimmedString(raw.external_editor_path),
    externalEditorLabel: optionalTrimmedString(raw.external_editor_label),
    persistedMarkedFolders: parsePersistedMarkedFolders(raw.persisted_marked_folders),
  };
}

function numberSetting(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(number) && number >= 1 && number <= 60 ? number : fallback;
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseUpdateChannel(value: unknown): UpdateChannel {
  return value === 'preview' ? 'preview' : DEFAULT_SETTINGS.updateChannel;
}

function parseTheme(value: unknown): AppSettings['theme'] {
  return value === 'system' || value === 'dark' || value === 'light'
    ? value
    : DEFAULT_SETTINGS.theme;
}

function parseSlideshowDirection(value: unknown): SlideshowDirection {
  return value === 'reverse' ? 'reverse' : DEFAULT_SETTINGS.slideshowDirection;
}

function parseCropSaveMode(value: unknown): AppSettings['cropSaveMode'] {
  return value === 'copy' || value === 'overwrite' ? value : DEFAULT_SETTINGS.cropSaveMode;
}

function parseMouseWheelBehavior(value: unknown): AppSettings['mouseWheelBehavior'] {
  return value === 'navigate' || value === 'zoom' ? value : DEFAULT_SETTINGS.mouseWheelBehavior;
}

function parseDefaultFitMode(value: unknown): AppSettings['defaultFitMode'] {
  return value === 'fit' || value === 'fill' || value === 'actual'
    ? value
    : DEFAULT_SETTINGS.defaultFitMode;
}

function parseSortSettings(
  criterion: unknown,
  direction: unknown
): Pick<AppSettings, 'sortOrder' | 'sortDirection'> {
  const legacyDate = criterion === 'date';
  const sortOrder =
    criterion === 'date'
      ? 'modified'
      : criterion === 'created' ||
          criterion === 'modified' ||
          criterion === 'name' ||
          criterion === 'size' ||
          criterion === 'random'
        ? criterion
        : DEFAULT_SETTINGS.sortOrder;
  const defaultDirection =
    sortOrder === 'name' ? 'ascending' : sortOrder === 'random' ? 'ascending' : 'descending';
  const sortDirection =
    direction === 'ascending' || direction === 'descending'
      ? direction
      : legacyDate
        ? 'descending'
        : defaultDirection;
  return { sortOrder, sortDirection };
}

function finiteNumberSetting(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveFiniteNumberSetting(value: unknown): number | undefined {
  const number = finiteNumberSetting(value);
  return number !== undefined && number > 0 ? number : undefined;
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

function isPinnableToolbarActionId(value: unknown): value is PinnableToolbarActionId {
  return (
    value === 'refresh' ||
    value === 'recent-folders' ||
    value === 'reveal' ||
    value === 'copy' ||
    value === 'copy-path' ||
    value === 'copy-to' ||
    value === 'move-to' ||
    value === 'edit' ||
    value === 'delete' ||
    value === 'projector' ||
    value === 'info' ||
    value === 'settings'
  );
}

function parsePinnedToolbarActions(raw: unknown): PinnableToolbarActionId[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_SETTINGS.pinnedToolbarActions;
  }

  const seen = new Set<PinnableToolbarActionId>();
  const pinnedActions: PinnableToolbarActionId[] = [];
  for (const value of raw) {
    if (!isPinnableToolbarActionId(value) || seen.has(value)) {
      continue;
    }

    seen.add(value);
    pinnedActions.push(value);
  }

  return pinnedActions;
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
    const x = finiteNumberSetting(bounds.x);
    const y = finiteNumberSetting(bounds.y);
    const width = positiveFiniteNumberSetting(bounds.width);
    const height = positiveFiniteNumberSetting(bounds.height);
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
      parsed[key] = { x, y, width, height };
    }
  }

  return parsed;
}

function parsePersistedMarkedFolders(raw: unknown): PersistedMarkedFolder[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_SETTINGS.persistedMarkedFolders;
  }

  const seen = new Set<string>();
  const folders: PersistedMarkedFolder[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const entry = value as Record<string, unknown>;
    const folderPath = String(entry.folder_path ?? '').trim();
    if (!folderPath) {
      continue;
    }

    const normalizedKey = folderPath.replace(/\\/g, '/').toLowerCase();
    if (seen.has(normalizedKey)) {
      continue;
    }

    const markedPaths = Array.isArray(entry.marked_paths)
      ? entry.marked_paths
          .map((path) => String(path ?? '').trim())
          .filter(Boolean)
          .filter((path, index, array) => {
            const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
            return (
              array.findIndex(
                (candidate) => candidate.replace(/\\/g, '/').toLowerCase() === normalizedPath
              ) === index
            );
          })
      : [];

    seen.add(normalizedKey);
    folders.push({
      folderPath,
      markedPaths,
      updatedAt: finiteNumberSetting(entry.updated_at) ?? 0,
    });
  }

  return folders;
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
      const openedAtValue = folder.opened_at ?? folder.openedAt;
      const openedAt =
        typeof openedAtValue === 'number' && Number.isFinite(openedAtValue)
          ? openedAtValue
          : undefined;
      if (!path || openedAt === undefined) {
        return null;
      }
      return { path, label, openedAt };
    })
    .filter((value): value is RecentFolder => value !== null)
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, MAX_RECENT_FOLDERS);
}

function parseSavedViewPresets(raw: unknown): CurationFilter[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_SETTINGS.savedViewPresets;
  }

  const seen = new Set<CurationFilter>();
  const presets: CurationFilter[] = [];
  for (const value of raw) {
    if (!isCurationFilter(value) || value === 'all' || seen.has(value)) {
      continue;
    }
    seen.add(value);
    presets.push(value);
  }

  return presets;
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

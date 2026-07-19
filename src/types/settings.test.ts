import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  rememberRecentFolder,
  settingsFromRust,
  settingsToRust,
  type AppSettings,
} from './settings';

describe('settingsToRust', () => {
  it('maps optional window bounds fields', () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      rememberWindowBounds: true,
      windowX: 120,
      windowY: 240,
      windowWidth: 1440,
      windowHeight: 900,
      lastWindowDisplayKey: 'display:0:0:3440x1440@1',
      windowBoundsByDisplay: {
        'display:0:0:3440x1440@1': { x: 40, y: 50, width: 1800, height: 1000 },
      },
    };

    expect(settingsToRust(settings)).toMatchObject({
      remember_window_bounds: true,
      window_x: 120,
      window_y: 240,
      window_width: 1440,
      window_height: 900,
      last_window_display_key: 'display:0:0:3440x1440@1',
      window_bounds_by_display: {
        'display:0:0:3440x1440@1': { x: 40, y: 50, width: 1800, height: 1000 },
      },
    });
  });

  it('keeps optional window bounds undefined when unset', () => {
    const rust = settingsToRust({ ...DEFAULT_SETTINGS, rememberWindowBounds: false });

    expect(rust).toMatchObject({
      remember_window_bounds: false,
      window_x: undefined,
      window_y: undefined,
      window_width: undefined,
      window_height: undefined,
    });
  });

  it('maps quick destinations to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      quickDestinations: [{ id: 'fav', label: 'Favorites', path: 'D:/Images/Favorites' }],
    });

    expect(rust).toMatchObject({
      quick_destinations: [{ id: 'fav', label: 'Favorites', path: 'D:/Images/Favorites' }],
    });
  });

  it('maps recent folders to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      recentFolders: [{ path: 'D:/Images', label: 'Images', openedAt: 123 }],
    });

    expect(rust).toMatchObject({
      recent_folders: [{ path: 'D:/Images', label: 'Images', opened_at: 123 }],
    });
  });

  it('maps external editor settings to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      externalEditorPath: 'C:/Program Files/Paint.NET/paintdotnet.exe',
      externalEditorLabel: 'Paint.NET',
      persistedMarkedFolders: [
        {
          folderPath: 'C:/Images',
          markedPaths: ['C:/Images/a.jpg'],
          updatedAt: 42,
        },
      ],
    });

    expect(rust).toMatchObject({
      external_editor_path: 'C:/Program Files/Paint.NET/paintdotnet.exe',
      external_editor_label: 'Paint.NET',
      persisted_marked_folders: [
        {
          folder_path: 'C:/Images',
          marked_paths: ['C:/Images/a.jpg'],
          updated_at: 42,
        },
      ],
    });
  });

  it('maps projector prompt preference to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      promptProjectorGridOnOpen: false,
      openProjectorInGridView: true,
    });

    expect(rust).toMatchObject({
      prompt_projector_grid_on_open: false,
      open_projector_in_grid_view: true,
    });
  });

  it('maps the image caption visibility preference to rust payloads', () => {
    expect(settingsToRust({ ...DEFAULT_SETTINGS, showImageCaptions: false })).toMatchObject({
      show_image_captions: false,
    });
  });

  it('maps performance mode to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      performanceMode: 'lowMemory',
    });

    expect(rust).toMatchObject({
      performance_mode: 'lowMemory',
    });
  });

  it('maps crop save mode to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      cropSaveMode: 'overwrite',
    });

    expect(rust).toMatchObject({
      crop_save_mode: 'overwrite',
    });
  });

  it('maps slideshow direction to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      slideshowDirection: 'reverse',
    });

    expect(rust).toMatchObject({
      slideshow_direction: 'reverse',
    });
  });

  it('maps auto-refresh folder preference to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      autoRefreshFolder: false,
    });

    expect(rust).toMatchObject({
      auto_refresh_folder: false,
    });
  });

  it('maps update channel to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      updateChannel: 'preview',
    });

    expect(rust).toMatchObject({
      update_channel: 'preview',
    });
  });

  it('maps saved view presets to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      savedViewPresets: ['favorites', 'rated5'],
    });

    expect(rust).toMatchObject({
      saved_view_presets: ['favorites', 'rated5'],
    });
  });
});

describe('settingsFromRust', () => {
  it('maps optional window bounds fields from rust payload', () => {
    const settings = settingsFromRust({
      remember_window_bounds: true,
      window_x: 300,
      window_y: 180,
      window_width: 1280,
      window_height: 720,
      last_window_display_key: 'display:0:0:2560x1440@1',
      window_bounds_by_display: {
        'display:0:0:2560x1440@1': { x: 10, y: 20, width: 1600, height: 900 },
      },
    });

    expect(settings.rememberWindowBounds).toBe(true);
    expect(settings.windowX).toBe(300);
    expect(settings.windowY).toBe(180);
    expect(settings.windowWidth).toBe(1280);
    expect(settings.windowHeight).toBe(720);
    expect(settings.lastWindowDisplayKey).toBe('display:0:0:2560x1440@1');
    expect(settings.windowBoundsByDisplay).toEqual({
      'display:0:0:2560x1440@1': { x: 10, y: 20, width: 1600, height: 900 },
    });
  });

  it('parses legacy settings without bounds fields', () => {
    const settings = settingsFromRust({
      theme: 'light',
      remember_window_bounds: true,
    });

    expect(settings.theme).toBe('light');
    expect(settings.rememberWindowBounds).toBe(true);
    expect(settings.windowX).toBeUndefined();
    expect(settings.windowY).toBeUndefined();
    expect(settings.windowWidth).toBeUndefined();
    expect(settings.windowHeight).toBeUndefined();
  });

  it('parses quick destinations from rust payloads and filters invalid entries', () => {
    const settings = settingsFromRust({
      quick_destinations: [
        { id: 'fav', label: 'Favorites', path: 'D:/Images/Favorites' },
        { id: '', label: 'Broken', path: 'D:/Broken' },
      ],
    });

    expect(settings.quickDestinations).toEqual([
      { id: 'fav', label: 'Favorites', path: 'D:/Images/Favorites' },
    ]);
  });

  it('parses recent folders from rust payloads and filters invalid entries', () => {
    const settings = settingsFromRust({
      recent_folders: [
        { path: 'D:/Images', label: 'Images', opened_at: 200 },
        { path: '', label: 'Broken', opened_at: 100 },
      ],
    });

    expect(settings.recentFolders).toEqual([{ path: 'D:/Images', label: 'Images', openedAt: 200 }]);
  });

  it('parses external editor settings from rust payloads', () => {
    const settings = settingsFromRust({
      external_editor_path: 'C:/Program Files/Paint.NET/paintdotnet.exe',
      external_editor_label: 'Paint.NET',
      persisted_marked_folders: [
        {
          folder_path: 'C:/Images',
          marked_paths: ['C:/Images/a.jpg'],
          updated_at: 42,
        },
      ],
    });

    expect(settings.externalEditorPath).toBe('C:/Program Files/Paint.NET/paintdotnet.exe');
    expect(settings.externalEditorLabel).toBe('Paint.NET');
    expect(settings.persistedMarkedFolders).toEqual([
      {
        folderPath: 'C:/Images',
        markedPaths: ['C:/Images/a.jpg'],
        updatedAt: 42,
      },
    ]);
  });

  it('parses projector prompt preference from rust payloads', () => {
    const settings = settingsFromRust({
      prompt_projector_grid_on_open: false,
      open_projector_in_grid_view: true,
    });

    expect(settings.promptProjectorGridOnOpen).toBe(false);
    expect(settings.openProjectorInGridView).toBe(true);
  });

  it('parses performance mode from rust payloads and falls back for unknown values', () => {
    expect(
      settingsFromRust({
        performance_mode: 'fast',
      }).performanceMode
    ).toBe('fast');

    expect(
      settingsFromRust({
        performance_mode: 'ultra',
      }).performanceMode
    ).toBe(DEFAULT_SETTINGS.performanceMode);
  });

  it('parses auto-refresh folder preference with a default enabled fallback', () => {
    expect(settingsFromRust({ auto_refresh_folder: false }).autoRefreshFolder).toBe(false);
    expect(settingsFromRust({}).autoRefreshFolder).toBe(true);
  });

  it('parses image caption visibility with a default enabled fallback', () => {
    expect(settingsFromRust({ show_image_captions: false }).showImageCaptions).toBe(false);
    expect(settingsFromRust({}).showImageCaptions).toBe(true);
  });

  it('parses update channel and falls back to stable', () => {
    expect(settingsFromRust({ update_channel: 'preview' }).updateChannel).toBe('preview');
    expect(settingsFromRust({ update_channel: 'nightly' }).updateChannel).toBe('stable');
    expect(settingsFromRust({}).updateChannel).toBe('stable');
  });

  it('parses crop save mode from rust payloads and defaults to copy', () => {
    expect(settingsFromRust({ crop_save_mode: 'overwrite' }).cropSaveMode).toBe('overwrite');
    expect(settingsFromRust({ crop_save_mode: 'mystery' }).cropSaveMode).toBe('copy');
    expect(settingsFromRust({}).cropSaveMode).toBe('copy');
  });

  it('parses slideshow direction and falls back to forward', () => {
    expect(settingsFromRust({ slideshow_direction: 'reverse' }).slideshowDirection).toBe('reverse');
    expect(settingsFromRust({ slideshow_direction: 'sideways' }).slideshowDirection).toBe(
      'forward'
    );
    expect(settingsFromRust({}).slideshowDirection).toBe('forward');
  });

  it('parses saved view presets and filters invalid values', () => {
    const settings = settingsFromRust({
      saved_view_presets: ['favorites', 'all', 'rated5', 'rated5', 'mystery'],
    });

    expect(settings.savedViewPresets).toEqual(['favorites', 'rated5']);
  });

  it('preserves an intentionally empty saved preset list', () => {
    const settings = settingsFromRust({
      saved_view_presets: [],
    });

    expect(settings.savedViewPresets).toEqual([]);
  });

  it('accepts every currently supported enum value and rejects invalid values independently', () => {
    expect(
      settingsFromRust({
        theme: 'system',
        slideshow_direction: 'forward',
        crop_save_mode: 'copy',
        mouse_wheel_behavior: 'navigate',
        default_fit_mode: 'actual',
        sort_order: 'random',
        performance_mode: 'lowMemory',
        update_channel: 'preview',
        saved_view_presets: ['unreviewed'],
      })
    ).toMatchObject({
      theme: 'system',
      slideshowDirection: 'forward',
      cropSaveMode: 'copy',
      mouseWheelBehavior: 'navigate',
      defaultFitMode: 'actual',
      sortOrder: 'random',
      performanceMode: 'lowMemory',
      updateChannel: 'preview',
      savedViewPresets: ['unreviewed'],
    });

    expect(
      settingsFromRust({
        theme: 'invalid',
        mouse_wheel_behavior: 'invalid',
        default_fit_mode: 'invalid',
        sort_order: 'invalid',
        update_channel: 'invalid',
        saved_view_presets: ['invalid', 'favorites'],
      })
    ).toMatchObject({
      theme: DEFAULT_SETTINGS.theme,
      mouseWheelBehavior: DEFAULT_SETTINGS.mouseWheelBehavior,
      defaultFitMode: DEFAULT_SETTINGS.defaultFitMode,
      sortOrder: DEFAULT_SETTINGS.sortOrder,
      updateChannel: DEFAULT_SETTINGS.updateChannel,
      savedViewPresets: ['favorites'],
    });
  });

  it('defaults invalid slideshow intervals and drops invalid numeric bounds and timestamps', () => {
    for (const interval of [0, 61, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        settingsFromRust({ slideshow_interval_seconds: interval }).slideshowIntervalSeconds
      ).toBe(DEFAULT_SETTINGS.slideshowIntervalSeconds);
    }

    const settings = settingsFromRust({
      window_x: Number.NaN,
      window_y: Number.POSITIVE_INFINITY,
      window_width: 0,
      window_height: -1,
      recent_folders: [
        { path: 'valid', opened_at: 12 },
        { path: 'invalid', opened_at: Number.NaN },
      ],
      persisted_marked_folders: [
        { folder_path: 'valid', marked_paths: [], updated_at: 42 },
        { folder_path: 'invalid', marked_paths: [], updated_at: Number.POSITIVE_INFINITY },
      ],
    });

    expect(settings.windowX).toBeUndefined();
    expect(settings.windowY).toBeUndefined();
    expect(settings.windowWidth).toBeUndefined();
    expect(settings.windowHeight).toBeUndefined();
    expect(settings.recentFolders).toEqual([{ path: 'valid', label: 'valid', openedAt: 12 }]);
    expect(settings.persistedMarkedFolders).toEqual([
      { folderPath: 'valid', markedPaths: [], updatedAt: 42 },
      { folderPath: 'invalid', markedPaths: [], updatedAt: 0 },
    ]);
  });
});

describe('rememberRecentFolder', () => {
  it('adds recent folders newest first and dedupes case-insensitively', () => {
    const first = rememberRecentFolder(DEFAULT_SETTINGS, 'D:/Images/Trips', 100);
    const second = rememberRecentFolder(
      { ...DEFAULT_SETTINGS, recentFolders: first },
      'd:/images/trips',
      200
    );

    expect(second).toEqual([{ path: 'd:/images/trips', label: 'trips', openedAt: 200 }]);
  });
});

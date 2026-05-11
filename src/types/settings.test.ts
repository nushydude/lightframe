import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settingsFromRust, settingsToRust, type AppSettings } from './settings';

describe('settingsToRust', () => {
  it('maps optional window bounds fields', () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      rememberWindowBounds: true,
      windowX: 120,
      windowY: 240,
      windowWidth: 1440,
      windowHeight: 900,
    };

    expect(settingsToRust(settings)).toMatchObject({
      remember_window_bounds: true,
      window_x: 120,
      window_y: 240,
      window_width: 1440,
      window_height: 900,
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

  it('maps external editor settings to rust payloads', () => {
    const rust = settingsToRust({
      ...DEFAULT_SETTINGS,
      externalEditorPath: 'C:/Program Files/Paint.NET/paintdotnet.exe',
      externalEditorLabel: 'Paint.NET',
    });

    expect(rust).toMatchObject({
      external_editor_path: 'C:/Program Files/Paint.NET/paintdotnet.exe',
      external_editor_label: 'Paint.NET',
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
    });

    expect(settings.rememberWindowBounds).toBe(true);
    expect(settings.windowX).toBe(300);
    expect(settings.windowY).toBe(180);
    expect(settings.windowWidth).toBe(1280);
    expect(settings.windowHeight).toBe(720);
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

  it('parses external editor settings from rust payloads', () => {
    const settings = settingsFromRust({
      external_editor_path: 'C:/Program Files/Paint.NET/paintdotnet.exe',
      external_editor_label: 'Paint.NET',
    });

    expect(settings.externalEditorPath).toBe('C:/Program Files/Paint.NET/paintdotnet.exe');
    expect(settings.externalEditorLabel).toBe('Paint.NET');
  });
});

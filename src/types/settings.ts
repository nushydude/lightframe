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
  sortOrder: 'name' | 'date' | 'size' | 'random';
  showThumbnails: boolean;
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
  sortOrder: 'name',
  showThumbnails: true,
};

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
    sort_order: settings.sortOrder,
    show_thumbnails: settings.showThumbnails,
  };
}

/** Convert Rust snake_case settings to frontend camelCase format */
export function settingsFromRust(raw: Record<string, unknown>): AppSettings {
  return {
    theme: (raw.theme as AppSettings['theme']) || DEFAULT_SETTINGS.theme,
    slideshowIntervalSeconds:
      (raw.slideshow_interval_seconds as number) ?? DEFAULT_SETTINGS.slideshowIntervalSeconds,
    loopSlideshow: (raw.loop_slideshow as boolean) ?? DEFAULT_SETTINGS.loopSlideshow,
    shuffleSlideshow: (raw.shuffle_slideshow as boolean) ?? DEFAULT_SETTINGS.shuffleSlideshow,
    autoFullscreenOnSlideshow:
      (raw.auto_fullscreen_on_slideshow as boolean) ?? DEFAULT_SETTINGS.autoFullscreenOnSlideshow,
    mouseWheelBehavior:
      (raw.mouse_wheel_behavior as AppSettings['mouseWheelBehavior']) ||
      DEFAULT_SETTINGS.mouseWheelBehavior,
    defaultFitMode:
      (raw.default_fit_mode as AppSettings['defaultFitMode']) || DEFAULT_SETTINGS.defaultFitMode,
    rememberWindowBounds:
      (raw.remember_window_bounds as boolean) ?? DEFAULT_SETTINGS.rememberWindowBounds,
    windowX: raw.window_x as number | undefined,
    windowY: raw.window_y as number | undefined,
    windowWidth: raw.window_width as number | undefined,
    windowHeight: raw.window_height as number | undefined,
    sortOrder:
      (raw.sort_order as AppSettings['sortOrder']) || DEFAULT_SETTINGS.sortOrder,
    showThumbnails: (raw.show_thumbnails as boolean) ?? DEFAULT_SETTINGS.showThumbnails,
  };
}

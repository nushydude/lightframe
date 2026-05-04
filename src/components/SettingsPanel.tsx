import React from 'react';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import type { AppSettings } from '../types/settings';

/** Settings panel overlay */
export function SettingsPanel() {
  const { settings, updateSettings } = useSettingsStore();
  const setShowSettings = useViewerStore((s) => s.setShowSettings);

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    updateSettings({ [key]: value });
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setShowSettings(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={handleOverlayClick}>
      <div className="settings-panel" role="dialog" aria-label="Settings">
        <div className="settings-header">
          <h2>Settings</h2>
          <button
            className="settings-close"
            onClick={() => setShowSettings(false)}
            aria-label="Close settings"
            id="btn-close-settings"
          >
            ✕
          </button>
        </div>

        <div className="settings-body">
          {/* Appearance */}
          <div className="settings-group">
            <div className="settings-group-title">Appearance</div>

            <div className="setting-row">
              <span className="setting-label">Theme</span>
              <select
                className="setting-select"
                value={settings.theme}
                onChange={(e) => handleChange('theme', e.target.value as AppSettings['theme'])}
                id="setting-theme"
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">System</option>
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-label">Default image fit</span>
              <select
                className="setting-select"
                value={settings.defaultFitMode}
                onChange={(e) => handleChange('defaultFitMode', e.target.value as AppSettings['defaultFitMode'])}
                id="setting-fit-mode"
              >
                <option value="fit">Fit to screen</option>
                <option value="fill">Fill screen</option>
                <option value="actual">Actual size</option>
              </select>
            </div>
          </div>

          {/* Slideshow */}
          <div className="settings-group">
            <div className="settings-group-title">Slideshow</div>

            <div className="setting-row">
              <span className="setting-label">Interval (seconds)</span>
              <input
                type="number"
                className="setting-input"
                value={settings.slideshowIntervalSeconds}
                min={1}
                max={60}
                onChange={(e) => {
                  const val = Math.max(1, Math.min(60, parseInt(e.target.value) || 4));
                  handleChange('slideshowIntervalSeconds', val);
                }}
                id="setting-slideshow-interval"
              />
            </div>

            <div className="setting-row">
              <span className="setting-label">Loop slideshow</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.loopSlideshow}
                  onChange={(e) => handleChange('loopSlideshow', e.target.checked)}
                  id="setting-loop-slideshow"
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="setting-row">
              <span className="setting-label">Shuffle slideshow</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.shuffleSlideshow}
                  onChange={(e) => handleChange('shuffleSlideshow', e.target.checked)}
                  id="setting-shuffle-slideshow"
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="setting-row">
              <span className="setting-label">Auto-fullscreen on slideshow</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.autoFullscreenOnSlideshow}
                  onChange={(e) => handleChange('autoFullscreenOnSlideshow', e.target.checked)}
                  id="setting-auto-fullscreen"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          {/* Navigation */}
          <div className="settings-group">
            <div className="settings-group-title">Navigation</div>

            <div className="setting-row">
              <span className="setting-label">Mouse wheel behavior</span>
              <select
                className="setting-select"
                value={settings.mouseWheelBehavior}
                onChange={(e) => handleChange('mouseWheelBehavior', e.target.value as AppSettings['mouseWheelBehavior'])}
                id="setting-mouse-wheel"
              >
                <option value="zoom">Zoom</option>
                <option value="navigate">Navigate</option>
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-label">Sort order</span>
              <select
                className="setting-select"
                value={settings.sortOrder}
                onChange={(e) => handleChange('sortOrder', e.target.value as AppSettings['sortOrder'])}
                id="setting-sort-order"
              >
                <option value="name">Name</option>
                <option value="date">Date Modified</option>
                <option value="size">File Size</option>
                <option value="random">Random</option>
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-label">Remember window size</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.rememberWindowBounds}
                  onChange={(e) => handleChange('rememberWindowBounds', e.target.checked)}
                  id="setting-remember-window"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

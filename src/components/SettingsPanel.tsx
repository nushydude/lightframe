import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import type { AppSettings, QuickDestination } from '../types/settings';
import { SAVED_VIEW_PRESET_OPTIONS, type CurationFilter } from '../services/curationFilter';
import {
  buildDiagnosticsFileName,
  buildDiagnosticsSnapshot,
  copyDiagnosticsText,
  serializeDiagnosticsSnapshot,
} from '../services/diagnosticsSnapshot';
import { getPerformanceTelemetrySnapshot } from '../services/performanceTelemetry';
import {
  clearGeneratedImageCache,
  getCodecHealth,
  getImageMetadata,
  openSettings,
  openUrlExternal,
  retryNativeCodecs,
  saveDiagnosticsSnapshot,
  type CodecHealthReport,
  type GeneratedCacheCommandScope,
} from '../services/tauriCommands';
import { PERFORMANCE_MODE_LABELS } from '../services/performanceMode';

interface RecentFoldersSettingsProps {
  settings: AppSettings;
  updateSettings: (settings: Partial<AppSettings>) => Promise<void>;
}

function normalizedFolderKey(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').toLowerCase();
}

function RecentFoldersSettings({ settings, updateSettings }: RecentFoldersSettingsProps) {
  const handleRemoveRecentFolder = async (folderPath: string) => {
    const normalizedPath = normalizedFolderKey(folderPath);
    await updateSettings({
      recentFolders: settings.recentFolders.filter(
        (folder) => normalizedFolderKey(folder.path) !== normalizedPath
      ),
    });
  };

  const handleClearRecentFolders = async () => {
    await updateSettings({ recentFolders: [] });
  };

  return (
    <div className="settings-group">
      <div className="settings-group-title">Recent Folders</div>
      {settings.recentFolders.length === 0 ? (
        <p className="setting-help">Opened folders will appear here for quick access.</p>
      ) : (
        <>
          <div className="setting-row setting-row-stack">
            <span className="setting-label">Folder history</span>
            <button
              className="setting-button-secondary"
              onClick={() => void handleClearRecentFolders()}
            >
              Clear all
            </button>
          </div>
          <div className="quick-destination-list">
            {settings.recentFolders.map((folder) => (
              <div className="quick-destination-item" key={folder.path}>
                <div className="quick-destination-meta">
                  <div className="quick-destination-label">{folder.label}</div>
                  <div className="quick-destination-path" title={folder.path}>
                    {folder.path}
                  </div>
                </div>
                <button
                  className="setting-button-secondary"
                  onClick={() => void handleRemoveRecentFolder(folder.path)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SavedViewPresetsSettings({ settings, updateSettings }: RecentFoldersSettingsProps) {
  const togglePreset = async (preset: CurationFilter) => {
    const nextPresets = settings.savedViewPresets.includes(preset)
      ? settings.savedViewPresets.filter((value) => value !== preset)
      : [...settings.savedViewPresets, preset];

    await updateSettings({ savedViewPresets: nextPresets });
  };

  return (
    <div className="settings-group">
      <div className="settings-group-title">Saved View Presets</div>
      <p className="setting-help">
        Choose which review views show up on recent folders so you can jump straight into them from
        launch.
      </p>
      <div className="settings-chip-list">
        {SAVED_VIEW_PRESET_OPTIONS.map((option) => {
          const isActive = settings.savedViewPresets.includes(option.value);
          return (
            <button
              key={option.value}
              className={`settings-chip ${isActive ? 'active' : ''}`}
              onClick={() => void togglePreset(option.value)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Settings panel overlay */
export function SettingsPanel() {
  const { settings, updateSettings } = useSettingsStore();
  const setShowSettings = useViewerStore((s) => s.setShowSettings);

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    void updateSettings({ [key]: value });
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setShowSettings(false);
    }
  };

  const handleAddQuickDestination = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== 'string') {
      return;
    }

    const normalizedPath = selected.trim();
    if (!normalizedPath) {
      return;
    }

    if (settings.quickDestinations.some((destination) => destination.path === normalizedPath)) {
      return;
    }

    const folderName = normalizedPath.replace(/\\/g, '/').split('/').pop() || normalizedPath;
    const nextDestination: QuickDestination = {
      id: `dest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: folderName,
      path: normalizedPath,
    };

    await updateSettings({
      quickDestinations: [...settings.quickDestinations, nextDestination],
    });
  };

  const handleRemoveQuickDestination = async (destinationId: string) => {
    await updateSettings({
      quickDestinations: settings.quickDestinations.filter(
        (destination) => destination.id !== destinationId
      ),
    });
  };

  const handleChooseExternalEditor = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: 'Applications', extensions: ['exe', 'bat', 'cmd', 'com'] }],
    });
    if (!selected || typeof selected !== 'string') {
      return;
    }

    const normalizedPath = selected.trim();
    if (!normalizedPath) {
      return;
    }

    const fileName = normalizedPath.replace(/\\/g, '/').split('/').pop() || normalizedPath;
    const label = fileName.replace(/\.[^.]+$/, '') || fileName;
    await updateSettings({
      externalEditorPath: normalizedPath,
      externalEditorLabel: label,
    });
  };

  const handleClearExternalEditor = async () => {
    await updateSettings({
      externalEditorPath: undefined,
      externalEditorLabel: undefined,
    });
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
                onChange={(e) =>
                  handleChange('defaultFitMode', e.target.value as AppSettings['defaultFitMode'])
                }
                id="setting-fit-mode"
              >
                <option value="fit">Fit to screen</option>
                <option value="fill">Fill screen</option>
                <option value="actual">Actual size</option>
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-label">Show thumbnail strip</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.showThumbnails}
                  onChange={(e) => handleChange('showThumbnails', e.target.checked)}
                  id="setting-show-thumbnails"
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="setting-row">
              <span className="setting-label">Performance mode</span>
              <select
                className="setting-select"
                value={settings.performanceMode}
                onChange={(e) =>
                  handleChange('performanceMode', e.target.value as AppSettings['performanceMode'])
                }
                id="setting-performance-mode"
              >
                <option value="fast">{PERFORMANCE_MODE_LABELS.fast}</option>
                <option value="balanced">{PERFORMANCE_MODE_LABELS.balanced}</option>
                <option value="lowMemory">{PERFORMANCE_MODE_LABELS.lowMemory}</option>
              </select>
            </div>
            <p className="setting-help">
              Fast keeps more previews and thumbnails warm. Low Memory trims caches harder and
              preloads fewer adjacent images.
            </p>
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
                onChange={(e) =>
                  handleChange(
                    'mouseWheelBehavior',
                    e.target.value as AppSettings['mouseWheelBehavior']
                  )
                }
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
                onChange={(e) =>
                  handleChange('sortOrder', e.target.value as AppSettings['sortOrder'])
                }
                id="setting-sort-order"
              >
                <option value="name">Name</option>
                <option value="date">Date Modified</option>
                <option value="size">File Size</option>
                <option value="random">Random</option>
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-label">Auto-refresh folders</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.autoRefreshFolder}
                  onChange={(e) => handleChange('autoRefreshFolder', e.target.checked)}
                  id="setting-auto-refresh-folder"
                />
                <span className="toggle-slider" />
              </label>
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

            <div className="setting-row">
              <span className="setting-label">Show projector grid suggestion</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.promptProjectorGridOnOpen}
                  onChange={(e) => handleChange('promptProjectorGridOnOpen', e.target.checked)}
                  id="setting-projector-grid-prompt"
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="setting-row">
              <span className="setting-label">Open projector in grid view</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.openProjectorInGridView}
                  onChange={(e) => handleChange('openProjectorInGridView', e.target.checked)}
                  id="setting-projector-grid-default"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <SavedViewPresetsSettings settings={settings} updateSettings={updateSettings} />

          <RecentFoldersSettings settings={settings} updateSettings={updateSettings} />

          <div className="settings-group">
            <div className="settings-group-title">Quick Destinations</div>
            <div className="setting-row setting-row-stack">
              <span className="setting-label">Destination folders</span>
              <button
                className="setting-button-secondary"
                onClick={() => void handleAddQuickDestination()}
                id="btn-add-quick-destination"
              >
                Add folder
              </button>
            </div>
            {settings.quickDestinations.length === 0 ? (
              <p className="setting-help">
                Add a folder here to enable quick copy and move actions.
              </p>
            ) : (
              <div className="quick-destination-list">
                {settings.quickDestinations.map((destination) => (
                  <div className="quick-destination-item" key={destination.id}>
                    <div className="quick-destination-meta">
                      <div className="quick-destination-label">{destination.label}</div>
                      <div className="quick-destination-path" title={destination.path}>
                        {destination.path}
                      </div>
                    </div>
                    <button
                      className="setting-button-secondary"
                      onClick={() => void handleRemoveQuickDestination(destination.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="settings-group">
            <div className="settings-group-title">External Editor</div>
            <div className="setting-row setting-row-stack">
              <span className="setting-label">Configured app</span>
              <div className="setting-button-row">
                <button
                  className="setting-button-secondary"
                  onClick={() => void handleChooseExternalEditor()}
                  id="btn-choose-external-editor"
                >
                  {settings.externalEditorPath ? 'Change app' : 'Choose app'}
                </button>
                {settings.externalEditorPath && (
                  <button
                    className="setting-button-secondary"
                    onClick={() => void handleClearExternalEditor()}
                    id="btn-clear-external-editor"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            {settings.externalEditorPath ? (
              <div className="quick-destination-list">
                <div className="quick-destination-item">
                  <div className="quick-destination-meta">
                    <div className="quick-destination-label">
                      {settings.externalEditorLabel || 'External Editor'}
                    </div>
                    <div className="quick-destination-path" title={settings.externalEditorPath}>
                      {settings.externalEditorPath}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <p className="setting-help">
                Choose an editor executable to enable Edit. LightFrame will open the current image
                path in that app.
              </p>
            )}
          </div>

          {/* System */}
          <div className="settings-group">
            <div className="settings-group-title">System</div>
            <div className="setting-row">
              <span className="setting-label">Default image viewer</span>
              <button
                className="setting-button-primary"
                onClick={openSettings}
                id="btn-set-default"
              >
                Open Default Apps Settings
              </button>
            </div>
            <p className="setting-help">
              To make LightFrame your default viewer, click the button above, find "LightFrame" in
              the list, and select it for your image formats.
            </p>
          </div>

          <CodecHealthSettings />
        </div>
      </div>
    </div>
  );
}

function CodecHealthSettings() {
  const [codecHealth, setCodecHealth] = React.useState<CodecHealthReport | null>(null);
  const [codecHealthStatus, setCodecHealthStatus] = React.useState<string | null>(null);
  const [isCodecHealthBusy, setIsCodecHealthBusy] = React.useState(false);

  const refreshCodecHealth = React.useCallback(async () => {
    setIsCodecHealthBusy(true);
    setCodecHealthStatus(null);
    try {
      setCodecHealth(await getCodecHealth());
    } catch (error) {
      setCodecHealthStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCodecHealthBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshCodecHealth();
  }, [refreshCodecHealth]);

  const handleRetryNativeCodecs = async () => {
    setIsCodecHealthBusy(true);
    setCodecHealthStatus(null);
    try {
      const cleared = await retryNativeCodecs();
      setCodecHealthStatus(cleared > 0 ? `Retry queue reset (${cleared})` : 'Retry queue clear');
      setCodecHealth(await getCodecHealth());
    } catch (error) {
      setCodecHealthStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCodecHealthBusy(false);
    }
  };

  const handleClearGeneratedCache = async (scope: GeneratedCacheCommandScope) => {
    setIsCodecHealthBusy(true);
    setCodecHealthStatus(null);
    try {
      await clearGeneratedImageCache(scope);
      setCodecHealth(await getCodecHealth());
      setCodecHealthStatus(`${formatCacheScope(scope)} cache cleared`);
    } catch (error) {
      setCodecHealthStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCodecHealthBusy(false);
    }
  };

  return (
    <div className="settings-group">
      <div className="settings-group-title">Format Support</div>
      <CodecHealthToolbar
        report={codecHealth}
        isBusy={isCodecHealthBusy}
        onRefresh={refreshCodecHealth}
        onRetryNative={handleRetryNativeCodecs}
      />
      {codecHealthStatus && <p className="setting-help">{codecHealthStatus}</p>}
      <CodecHealthList report={codecHealth} />
      <CodecCacheSummary report={codecHealth} />
      <CodecStoreLinks />
      <div className="setting-row">
        <button
          className="setting-button-secondary"
          onClick={() => void handleClearGeneratedCache('previews')}
          disabled={isCodecHealthBusy}
        >
          Clear Previews
        </button>
        <button
          className="setting-button-secondary"
          onClick={() => void handleClearGeneratedCache('all')}
          disabled={isCodecHealthBusy}
        >
          Clear All Generated
        </button>
      </div>
      <DiagnosticsSettings codecHealth={codecHealth} />
    </div>
  );
}

function DiagnosticsSettings({ codecHealth }: { codecHealth: CodecHealthReport | null }) {
  const settings = useSettingsStore((state) => state.settings);
  const currentImagePath = useViewerStore((state) => state.currentImagePath);
  const folderPath = useViewerStore((state) => state.folderPath);
  const currentIndex = useViewerStore((state) => state.currentIndex);
  const images = useViewerStore((state) => state.images);
  const allImages = useViewerStore((state) => state.allImages);
  const viewMode = useViewerStore((state) => state.viewMode);
  const zoomMode = useViewerStore((state) => state.zoomMode);
  const zoomLevel = useViewerStore((state) => state.zoomLevel);
  const isFullscreen = useViewerStore((state) => state.isFullscreen);
  const isSlideshowActive = useViewerStore((state) => state.isSlideshowActive);
  const isFolderScanning = useViewerStore((state) => state.isFolderScanning);
  const curationFilter = useViewerStore((state) => state.curationFilter);
  const showPerformanceTelemetry = useViewerStore((state) => state.showPerformanceTelemetry);
  const [status, setStatus] = React.useState<string | null>(null);
  const [isBusy, setIsBusy] = React.useState(false);

  const collectDiagnosticsText = React.useCallback(async () => {
    const probeErrors: { codecHealth?: string; currentImageMetadata?: string } = {};

    let freshCodecHealth = codecHealth;
    if (!freshCodecHealth) {
      try {
        freshCodecHealth = await getCodecHealth();
      } catch (error) {
        probeErrors.codecHealth = error instanceof Error ? error.message : String(error);
        freshCodecHealth = null;
      }
    }

    let currentImageMetadata = null;
    if (currentImagePath) {
      try {
        currentImageMetadata = await getImageMetadata(currentImagePath);
      } catch (error) {
        probeErrors.currentImageMetadata = error instanceof Error ? error.message : String(error);
      }
    }

    const snapshot = buildDiagnosticsSnapshot({
      settings,
      viewer: {
        currentImagePath,
        folderPath,
        currentIndex,
        visibleImageCount: images.length,
        folderImageCount: allImages.length > 0 ? allImages.length : images.length,
        viewMode,
        zoomMode,
        zoomLevel,
        isFullscreen,
        isSlideshowActive,
        isFolderScanning,
        curationFilter,
        showPerformanceTelemetry,
      },
      codecHealth: freshCodecHealth,
      telemetry: getPerformanceTelemetrySnapshot(),
      currentImageMetadata,
      probeErrors,
      windowLabel: getCurrentWindow().label,
    });

    return serializeDiagnosticsSnapshot(snapshot);
  }, [
    allImages.length,
    codecHealth,
    curationFilter,
    currentImagePath,
    currentIndex,
    folderPath,
    images.length,
    isFolderScanning,
    isFullscreen,
    isSlideshowActive,
    settings,
    showPerformanceTelemetry,
    viewMode,
    zoomLevel,
    zoomMode,
  ]);

  const handleCopyDiagnostics = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      await copyDiagnosticsText(await collectDiagnosticsText());
      setStatus('Diagnostics copied');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveDiagnostics = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      const outputPath = await save({
        defaultPath: buildDiagnosticsFileName(),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!outputPath) {
        return;
      }

      await saveDiagnosticsSnapshot(outputPath, await collectDiagnosticsText());
      setStatus('Diagnostics saved');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="settings-group">
      <div className="settings-group-title">Diagnostics</div>
      <p className="setting-help">
        Capture a support snapshot with app version, active settings, codec health, cache/runtime
        stats, current image metadata, and the latest performance telemetry.
      </p>
      <div className="setting-row">
        <span className="setting-label">Support snapshot</span>
        <div className="setting-button-row">
          <button
            className="setting-button-secondary"
            onClick={() => void handleCopyDiagnostics()}
            disabled={isBusy}
          >
            Copy Diagnostics
          </button>
          <button
            className="setting-button-secondary"
            onClick={() => void handleSaveDiagnostics()}
            disabled={isBusy}
          >
            Save JSON
          </button>
        </div>
      </div>
      {status && <p className="setting-help">{status}</p>}
    </div>
  );
}

function CodecHealthToolbar({
  report,
  isBusy,
  onRefresh,
  onRetryNative,
}: {
  report: CodecHealthReport | null;
  isBusy: boolean;
  onRefresh: () => Promise<void>;
  onRetryNative: () => Promise<void>;
}) {
  return (
    <div className="codec-health-toolbar">
      <div className="codec-health-cache">
        Cache {formatBytes(report?.generatedCache.totalSizeBytes ?? 0)}
        {' / '}
        {report?.generatedCache.totalFileCount ?? 0} files
      </div>
      <div className="setting-button-row">
        <button
          className="setting-button-secondary"
          onClick={() => void onRefresh()}
          disabled={isBusy}
        >
          Refresh
        </button>
        <button
          className="setting-button-secondary"
          onClick={() => void onRetryNative()}
          disabled={isBusy}
        >
          Retry Native
        </button>
      </div>
    </div>
  );
}

function CodecHealthList({ report }: { report: CodecHealthReport | null }) {
  return (
    <div className="codec-health-list">
      {(report?.entries ?? []).map((entry) => (
        <div className="codec-health-item" key={entry.label}>
          <div className="codec-health-main">
            <div className="codec-health-title-row">
              <span className="codec-health-title">{entry.label}</span>
              <span className={`codec-health-status codec-health-status--${entry.status}`}>
                {formatCodecStatus(entry.status)}
              </span>
            </div>
            <div className="codec-health-meta">
              {entry.extensions.map((extension) => `.${extension}`).join(' ')}
            </div>
            {entry.nativeDecoderNames.length > 0 && (
              <div className="codec-health-meta">{entry.nativeDecoderNames.join(', ')}</div>
            )}
            {entry.nativeSupportedExtensions.length > 0 && (
              <div className="codec-health-meta">
                Native .{entry.nativeSupportedExtensions.join(' .')}
              </div>
            )}
            {entry.nativeMissingExtensions.length > 0 && (
              <div className="codec-health-meta">
                Missing .{entry.nativeMissingExtensions.join(' .')}
              </div>
            )}
            <div className="codec-health-note">{entry.note}</div>
          </div>
          <div className="codec-health-backends">
            <span>M {formatBackend(entry.metadataBackend)}</span>
            <span>T {formatBackend(entry.thumbnailBackend)}</span>
            <span>D {formatBackend(entry.detailBackend)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CodecCacheSummary({ report }: { report: CodecHealthReport | null }) {
  if (!report) {
    return null;
  }

  return (
    <>
      <div className="codec-cache-grid">
        {report.generatedCache.buckets.map((bucket) => (
          <div className="codec-cache-bucket" key={bucket.scope}>
            <span>{formatCacheScope(bucket.scope)}</span>
            <strong>{formatBytes(bucket.sizeBytes)}</strong>
            <small>{bucket.fileCount} files</small>
          </div>
        ))}
        <div className="codec-cache-bucket">
          <span>Native retries</span>
          <strong>{report.generatedCache.rawNativeFailureCount}</strong>
          <small>deferred</small>
        </div>
      </div>
      <div className="codec-health-runtime">
        Runtime {runtimeCacheHits(report)} hits / {runtimeNativeGenerations(report)} native /{' '}
        {runtimePlaceholderGenerations(report)} placeholders
      </div>
      <div className="codec-health-runtime">
        Preview avg {formatRuntimeTiming(report.runtimeStats.nativePreviewTiming, 'WIC')} /{' '}
        {formatRuntimeTiming(report.runtimeStats.rustPreviewTiming, 'Rust')} /{' '}
        {formatRuntimeTiming(report.runtimeStats.placeholderPreviewTiming, 'Fallback')}
      </div>
      <div className="codec-health-runtime">
        Tile avg {formatRuntimeTiming(report.runtimeStats.nativeTileTiming, 'WIC')} /{' '}
        {formatRuntimeTiming(report.runtimeStats.rustTileTiming, 'JPEG')}
      </div>
    </>
  );
}

function CodecStoreLinks() {
  return (
    <div className="setting-row">
      <button
        className="setting-button-secondary"
        onClick={() => openUrlExternal('ms-windows-store://pdp/?ProductId=9PMMSR1CGPWG')}
      >
        Get HEIF Extensions
      </button>
      <button
        className="setting-button-secondary"
        onClick={() => openUrlExternal('ms-windows-store://pdp/?ProductId=9NMZLZ57R3T7')}
      >
        Get HEVC Extensions
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatBackend(backend: string): string {
  switch (backend) {
    case 'rust_image':
      return 'Rust';
    case 'windows_native':
      return 'WIC';
    case 'browser_renderable':
      return 'Browser';
    case 'unsupported':
      return 'No';
    default:
      return backend;
  }
}

function formatCodecStatus(status: string): string {
  switch (status) {
    case 'native-ready':
      return 'Native';
    case 'preview-first':
      return 'Preview';
    case 'fallback':
      return 'Fallback';
    case 'partial':
      return 'Partial';
    case 'ready':
      return 'Ready';
    default:
      return status;
  }
}

function formatCacheScope(scope: string): string {
  switch (scope) {
    case 'all':
      return 'Generated';
    case 'thumbnails':
      return 'Thumbnails';
    case 'previews':
      return 'Previews';
    case 'tiles':
      return 'Tiles';
    default:
      return scope;
  }
}

function runtimeCacheHits(report: CodecHealthReport): number {
  return (
    report.runtimeStats.thumbnailCacheHits +
    report.runtimeStats.previewCacheHits +
    report.runtimeStats.tileCacheHits
  );
}

function runtimeNativeGenerations(report: CodecHealthReport): number {
  return (
    report.runtimeStats.nativeThumbnailGenerations + report.runtimeStats.nativePreviewGenerations
  );
}

function runtimePlaceholderGenerations(report: CodecHealthReport): number {
  return (
    report.runtimeStats.placeholderThumbnailGenerations +
    report.runtimeStats.placeholderPreviewGenerations
  );
}

function formatRuntimeTiming(
  timing: { sampleCount: number; totalMs: number; maxMs: number },
  label: string
): string {
  if (timing.sampleCount <= 0) {
    return `${label} --`;
  }

  const averageMs = timing.totalMs / timing.sampleCount;
  return `${label} ${Math.round(averageMs)} ms avg (${timing.sampleCount}, max ${Math.round(
    timing.maxMs
  )} ms)`;
}

import { useSettingsStore } from '../state/settingsStore';
import { getCurationFilterLabel, type CurationFilter } from '../services/curationFilter';

interface EmptyStateProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecentFolder: (folderPath: string, filter?: CurationFilter) => void | Promise<void>;
}

export function EmptyState({ onOpenFile, onOpenFolder, onOpenRecentFolder }: EmptyStateProps) {
  const recentFolders = useSettingsStore((state) => state.settings.recentFolders);
  const savedViewPresets = useSettingsStore((state) => state.settings.savedViewPresets);

  return (
    <div className="empty-state">
      <div className="empty-state-icon">🖼</div>
      <h1>LightFrame</h1>
      <p>
        A fast, minimal image viewer. Open an image to get started, or drag and drop one into this
        window.
      </p>
      <div className="empty-state-actions">
        <button className="btn-primary" onClick={onOpenFile} id="btn-open-image">
          Open Image
        </button>
        <button
          className="btn-secondary"
          onClick={onOpenFolder}
          id="btn-open-folder"
          style={{
            marginLeft: '1rem',
            background: 'rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: 'white',
            padding: '0.6rem 1.2rem',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Open Folder
        </button>
      </div>
      {recentFolders.length > 0 && (
        <div className="empty-state-recent" aria-label="Recent folders">
          <div className="empty-state-recent-title">Recent Folders</div>
          <div className="empty-state-recent-list">
            {recentFolders.slice(0, 5).map((folder) => (
              <div className="empty-state-recent-entry" key={folder.path}>
                <button
                  className="empty-state-recent-item"
                  onClick={() => void onOpenRecentFolder(folder.path)}
                  title={folder.path}
                  type="button"
                >
                  {folder.label}
                </button>
                {savedViewPresets.length > 0 && (
                  <div className="empty-state-preset-row">
                    {savedViewPresets.map((preset) => (
                      <button
                        key={`${folder.path}:${preset}`}
                        className="empty-state-preset-chip"
                        onClick={() => void onOpenRecentFolder(folder.path, preset)}
                        type="button"
                      >
                        {getCurationFilterLabel(preset)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="shortcut-hints">
        <div className="shortcut-hint">
          <span className="shortcut-key">Ctrl+O</span>
          <span>Open file</span>
        </div>
        <div className="shortcut-hint">
          <span className="shortcut-key">← →</span>
          <span>Navigate</span>
        </div>
        <div className="shortcut-hint">
          <span className="shortcut-key">F5</span>
          <span>Slideshow</span>
        </div>
        <div className="shortcut-hint">
          <span className="shortcut-key">F11</span>
          <span>Fullscreen</span>
        </div>
        <div className="shortcut-hint">
          <span className="shortcut-key">+ −</span>
          <span>Zoom</span>
        </div>
        <div className="shortcut-hint">
          <span className="shortcut-key">Ctrl+,</span>
          <span>Settings</span>
        </div>
      </div>
    </div>
  );
}

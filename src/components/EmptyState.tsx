interface EmptyStateProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
}

export function EmptyState({ onOpenFile, onOpenFolder }: EmptyStateProps) {
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

import { useSettingsStore } from '../state/settingsStore';
import type { AppSettings } from '../types/settings';

const labels: Record<AppSettings['sortOrder'], string> = {
  name: 'Filename',
  date: 'Date Modified',
  created: 'Date Created',
  modified: 'Date Modified',
  size: 'File Size',
  random: 'Random',
};

export function FolderSortMenu() {
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const summary =
    settings.sortOrder === 'random'
      ? 'Sort: Random'
      : `Sort: ${labels[settings.sortOrder]} ${settings.sortDirection === 'ascending' ? '↑' : '↓'}`;

  const change = (partial: Partial<Pick<AppSettings, 'sortOrder' | 'sortDirection'>>) => {
    void updateSettings(partial);
  };

  const reshuffle = () => window.dispatchEvent(new Event('lightframe-reshuffle-folder'));

  return (
    <div className="folder-sort-menu" aria-label="Folder sort">
      <div className="top-bar-menu-section-label">{summary}</div>
      <label className="folder-sort-field">
        <span>Sort by</span>
        <select
          className="folder-sort-select"
          aria-label="Sort by"
          value={settings.sortOrder}
          onChange={(event) =>
            change({ sortOrder: event.target.value as AppSettings['sortOrder'] })
          }
        >
          <option value="name">Filename</option>
          <option value="created">Date Created</option>
          <option value="modified">Date Modified</option>
          <option value="size">File Size</option>
          <option value="random">Random</option>
        </select>
      </label>
      <label className="folder-sort-field">
        <span>Direction</span>
        <select
          className="folder-sort-select"
          aria-label="Direction"
          value={settings.sortDirection}
          disabled={settings.sortOrder === 'random'}
          onChange={(event) =>
            change({ sortDirection: event.target.value as AppSettings['sortDirection'] })
          }
        >
          <option value="ascending">Ascending</option>
          <option value="descending">Descending</option>
        </select>
      </label>
      {settings.sortOrder === 'random' && (
        <button className="top-bar-menu-item" type="button" onClick={reshuffle}>
          Reshuffle
        </button>
      )}
    </div>
  );
}

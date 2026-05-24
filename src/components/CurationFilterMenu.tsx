import {
  CURATION_FILTER_OPTIONS,
  getCurationFilterLabel,
  type CurationFilter,
} from '../services/curationFilter';
import { ToolbarIcon } from './ToolbarIcon';

interface CurationFilterMenuProps {
  currentFilter: CurationFilter;
  onSelect: (filter: CurationFilter) => void;
  labeled?: boolean;
}

export function CurationFilterMenu({
  currentFilter,
  onSelect,
  labeled = true,
}: CurationFilterMenuProps) {
  const triggerLabel = currentFilter === 'all' ? 'Filter' : getCurationFilterLabel(currentFilter);

  return (
    <details className="top-bar-menu">
      <summary
        className={`top-bar-btn ${labeled ? 'top-bar-btn--labeled ' : ''}has-tooltip ${
          currentFilter !== 'all' ? 'active' : ''
        }`}
        aria-label="Filter images"
        data-tooltip="Filter images"
        title="Filter images"
      >
        <span className="top-bar-btn-icon">
          <ToolbarIcon name="filter" />
        </span>
        {labeled && <span className="top-bar-btn-label">{triggerLabel}</span>}
      </summary>
      <div className="top-bar-menu-panel">
        {CURATION_FILTER_OPTIONS.map((option) => {
          const isActive = option.value === currentFilter;

          return (
            <button
              key={option.value}
              className={`top-bar-menu-item ${isActive ? 'active' : ''}`}
              onClick={(event) => {
                onSelect(option.value);
                const details = event.currentTarget.closest('details');
                if (details instanceof HTMLDetailsElement) {
                  details.open = false;
                }
              }}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </details>
  );
}

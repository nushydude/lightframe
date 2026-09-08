import { getCurationFilterCountLabel, type CurationFilter } from '../services/curationFilter';

interface FilteredCurationEmptyStateProps {
  filter: CurationFilter;
  onShowAll: () => void;
}

export function FilteredCurationEmptyState({ filter, onShowAll }: FilteredCurationEmptyStateProps) {
  return (
    <div className="contact-sheet-empty" role="status" aria-live="polite">
      <p>No {getCurationFilterCountLabel(filter)} found in the current folder.</p>
      <button
        className="top-bar-menu-item"
        type="button"
        onClick={onShowAll}
        aria-label="Show all images"
      >
        Show all images
      </button>
    </div>
  );
}

type ToolbarIconName =
  | 'copy'
  | 'delete'
  | 'edit'
  | 'favorite'
  | 'favorites'
  | 'filter'
  | 'first'
  | 'fit'
  | 'folder'
  | 'info'
  | 'more'
  | 'move'
  | 'next'
  | 'pause'
  | 'pin'
  | 'previous'
  | 'projector'
  | 'refresh'
  | 'reveal'
  | 'rotateCcw'
  | 'rotateCw'
  | 'settings'
  | 'slideshow'
  | 'zoomIn'
  | 'zoomOut';

interface ToolbarIconProps {
  name: ToolbarIconName;
}

const ICON_PATHS: Record<ToolbarIconName, string[]> = {
  copy: ['M9 9h10v10H9z', 'M5 5h10v2', 'M5 5v10h2'],
  delete: ['M5 7h14', 'M9 7V5h6v2', 'M8 7l1 12h6l1-12', 'M10 10v6', 'M14 10v6'],
  edit: ['M4 20h4l10-10-4-4L4 16v4', 'M12 6l4 4', 'M15 5 19 9'],
  favorite: ['M12 3.5 14.7 8.8l5.8.8-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.8-.8L12 3.5Z'],
  favorites: [
    'M11.5 3.5 13.7 8l5 .7-3.6 3.5.9 5-4.5-2.4L7 17.2l.9-5-3.6-3.5 5-.7 2.2-4.5Z',
    'M17 4.5h2.5M17 7h4M17 9.5h2.5',
  ],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  first: ['M6 6v12', 'M18 6 10 12l8 6V6Z'],
  fit: ['M5 9V5h4', 'M15 5h4v4', 'M19 15v4h-4', 'M9 19H5v-4'],
  folder: ['M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', 'M3 9h18'],
  info: ['M12 8h.01', 'M11 12h2v5h-2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  move: ['M13 5h6v6', 'M19 5 10 14', 'M5 9v10h10'],
  next: ['M9 6l6 6-6 6'],
  pause: ['M7 5h3v14H7V5Zm7 0h3v14h-3V5Z'],
  pin: ['M9 4h6l1 4 3 3-2 2-3-3-4-1V4Z', 'M12 13v7'],
  previous: ['M15 6 9 12l6 6'],
  projector: ['M4 6h16v9H4z', 'M8 19h8', 'M12 15v4'],
  refresh: [
    'M20 6v5h-5',
    'M4 18v-5h5',
    'M6.5 10a6 6 0 0 1 10-2L20 11',
    'M17.5 14a6 6 0 0 1-10 2L4 13',
  ],
  reveal: [
    'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  ],
  rotateCcw: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4.5v6h6'],
  rotateCw: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4.5v6h-6'],
  settings: [
    'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
    'M12 2v3',
    'M12 19v3',
    'M4.9 4.9l2.1 2.1',
    'M17 17l2.1 2.1',
    'M2 12h3',
    'M19 12h3',
    'M4.9 19.1 7 17',
    'M17 7l2.1-2.1',
  ],
  slideshow: ['M7 5v14l11-7L7 5Z', 'M3.5 6.5v11', 'M20.5 6.5v11'],
  zoomIn: ['M11 5v12', 'M5 11h12'],
  zoomOut: ['M5 11h12'],
};

export function ToolbarIcon({ name }: ToolbarIconProps) {
  return (
    <svg className="toolbar-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      {ICON_PATHS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

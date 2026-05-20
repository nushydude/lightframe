type ToolbarIconName =
  | 'favorite'
  | 'favorites'
  | 'first'
  | 'fit'
  | 'more'
  | 'next'
  | 'pause'
  | 'previous'
  | 'rotateCcw'
  | 'rotateCw'
  | 'slideshow'
  | 'zoomIn'
  | 'zoomOut';

interface ToolbarIconProps {
  name: ToolbarIconName;
}

const ICON_PATHS: Record<ToolbarIconName, string[]> = {
  favorite: ['M12 3.5 14.7 8.8l5.8.8-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.8-.8L12 3.5Z'],
  favorites: [
    'M11.5 3.5 13.7 8l5 .7-3.6 3.5.9 5-4.5-2.4L7 17.2l.9-5-3.6-3.5 5-.7 2.2-4.5Z',
    'M17 4.5h2.5M17 7h4M17 9.5h2.5',
  ],
  first: ['M6 6v12', 'M18 6 10 12l8 6V6Z'],
  fit: ['M5 9V5h4', 'M15 5h4v4', 'M19 15v4h-4', 'M9 19H5v-4'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  next: ['M9 6l6 6-6 6'],
  pause: ['M7 5h3v14H7V5Zm7 0h3v14h-3V5Z'],
  previous: ['M15 6 9 12l6 6'],
  rotateCcw: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4.5v6h6'],
  rotateCw: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4.5v6h-6'],
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

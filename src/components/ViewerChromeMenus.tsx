import { useRef, type RefObject } from 'react';
import { ToolbarIcon } from './ToolbarIcon';

export interface MenuShortcutAction {
  label: string;
  icon?: Parameters<typeof ToolbarIcon>[0]['name'];
  shortcut?: string;
}

export interface SlideshowOptionsProps {
  menuRef: RefObject<HTMLDetailsElement | null>;
  canStart: boolean;
  shuffle: boolean;
  direction: 'forward' | 'reverse';
  repeat: boolean;
  interval: number;
  autoFullscreen: boolean;
  updateSettings: (partial: {
    shuffleSlideshow?: boolean;
    slideshowDirection?: 'forward' | 'reverse';
    loopSlideshow?: boolean;
    slideshowIntervalSeconds?: number;
    autoFullscreenOnSlideshow?: boolean;
  }) => Promise<boolean>;
}

export function SlideshowOptions({
  menuRef,
  canStart,
  shuffle,
  direction,
  repeat,
  interval,
  autoFullscreen,
  updateSettings,
}: SlideshowOptionsProps) {
  const triggerRef = useRef<HTMLElement | null>(null);

  const closeAndRestoreFocus = () => {
    if (menuRef.current?.open) {
      menuRef.current.open = false;
      triggerRef.current?.focus();
    }
  };

  return (
    <details ref={menuRef} className="slideshow-options-menu">
      <summary
        ref={triggerRef}
        className="control-btn control-btn--text slideshow-options-trigger"
        aria-label="Slideshow options"
        aria-disabled={!canStart}
        onClick={(event) => {
          if (!canStart) event.preventDefault();
        }}
      >
        Slideshow options
      </summary>
      <div
        className="slideshow-options-panel"
        role="group"
        aria-label="Slideshow options"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeAndRestoreFocus();
          }
        }}
      >
        <label className="slideshow-options-field">
          <span>Order</span>
          <select
            aria-label="Slideshow order"
            value={shuffle ? 'shuffle' : 'sequential'}
            onChange={(event) =>
              void updateSettings({ shuffleSlideshow: event.target.value === 'shuffle' })
            }
          >
            <option value="sequential">Sequential</option>
            <option value="shuffle">Shuffle</option>
          </select>
        </label>
        <label className="slideshow-options-field">
          <span>Direction</span>
          <select
            aria-label="Slideshow direction"
            value={direction}
            onChange={(event) =>
              void updateSettings({
                slideshowDirection: event.target.value as 'forward' | 'reverse',
              })
            }
          >
            <option value="forward">Forward</option>
            <option value="reverse">Reverse</option>
          </select>
        </label>
        <label className="slideshow-options-field">
          <span>Repeat</span>
          <select
            aria-label="Slideshow repeat"
            value={repeat ? 'on' : 'off'}
            onChange={(event) =>
              void updateSettings({ loopSlideshow: event.target.value === 'on' })
            }
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>
        <label className="slideshow-options-field">
          <span>Interval (seconds)</span>
          <input
            aria-label="Slideshow interval in seconds"
            type="number"
            min={1}
            max={60}
            step={1}
            value={interval}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isInteger(next)) {
                void updateSettings({ slideshowIntervalSeconds: Math.min(60, Math.max(1, next)) });
              }
            }}
          />
        </label>
        <label className="slideshow-options-checkbox">
          <input
            aria-label="Enter fullscreen automatically"
            type="checkbox"
            checked={autoFullscreen}
            onChange={(event) =>
              void updateSettings({ autoFullscreenOnSlideshow: event.target.checked })
            }
          />
          <span>Enter fullscreen automatically</span>
        </label>
      </div>
    </details>
  );
}

export function MenuLabel({ label, icon, shortcut }: MenuShortcutAction) {
  return (
    <span className="menu-shortcut-row">
      <span className="menu-shortcut-label">
        {icon ? (
          <span className="menu-shortcut-icon" aria-hidden="true">
            <ToolbarIcon name={icon} />
          </span>
        ) : null}
        <span>{label}</span>
      </span>
      {shortcut ? <span className="shortcut-key menu-shortcut-key">{shortcut}</span> : null}
    </span>
  );
}

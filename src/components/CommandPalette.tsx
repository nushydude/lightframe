import { useEffect, useMemo, useRef, useState } from 'react';
import type { ViewerCommand } from '../services/commandRegistry';
import { useViewerStore } from '../state/viewerStore';

interface CommandPaletteProps {
  commands: ViewerCommand[];
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ commands, isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewerState = useViewerStore();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [isOpen]);

  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return commands.filter((command) => {
      if (!command.isEnabled(viewerState)) {
        return false;
      }

      if (normalizedQuery.length === 0) {
        return true;
      }

      const searchableText = [command.label, ...(command.keywords ?? [])].join(' ').toLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [commands, query, viewerState]);

  useEffect(() => {
    if (filteredCommands.length === 0) {
      setActiveIndex(0);
      return;
    }

    if (activeIndex >= filteredCommands.length) {
      setActiveIndex(filteredCommands.length - 1);
    }
  }, [activeIndex, filteredCommands]);

  const runCommand = async (command: ViewerCommand) => {
    await command.run();
    onClose();
  };

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filteredCommands.length === 0) {
        return;
      }

      setActiveIndex((current) => (current + 1) % filteredCommands.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filteredCommands.length === 0) {
        return;
      }

      setActiveIndex(
        (current) => (current - 1 + filteredCommands.length) % filteredCommands.length
      );
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const command = filteredCommands[activeIndex];
      if (command) {
        await runCommand(command);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="command-palette-header">
          <h2 id="command-palette-title">Command Palette</h2>
          <input
            ref={inputRef}
            className="command-palette-input"
            aria-label="Search commands"
            placeholder="Type a command"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>

        <ul className="command-palette-list" role="listbox" aria-label="Available commands">
          {filteredCommands.length === 0 ? (
            <li className="command-palette-empty">No matching commands</li>
          ) : (
            filteredCommands.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  className={`command-palette-item ${index === activeIndex ? 'active' : ''}`}
                  onClick={() => void runCommand(command)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span>{command.label}</span>
                  {command.shortcut && (
                    <span className="command-palette-shortcut">{command.shortcut}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

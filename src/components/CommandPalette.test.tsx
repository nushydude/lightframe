import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CommandPalette } from './CommandPalette';
import type { ViewerCommand } from '../services/commandRegistry';
import { useViewerStore } from '../state/viewerStore';

describe('CommandPalette', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
  });

  function renderPalette(commands: ViewerCommand[]) {
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} isOpen onClose={onClose} />);
    return { onClose };
  }

  const baseCommands: ViewerCommand[] = [
    {
      id: 'open-file',
      label: 'Open File',
      keywords: ['file'],
      shortcut: 'Ctrl+O',
      isEnabled: () => true,
      run: vi.fn(),
    },
    {
      id: 'next-image',
      label: 'Next Image',
      keywords: ['next'],
      isEnabled: () => true,
      run: vi.fn(),
    },
  ];

  it('renders and focuses search input', () => {
    renderPalette(baseCommands);

    const input = screen.getByLabelText('Search commands');
    expect(input).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('dialog', { name: 'Command Palette' })).toBeInTheDocument();
  });

  it('filters commands by label and keywords', () => {
    renderPalette(baseCommands);

    const input = screen.getByLabelText('Search commands');
    fireEvent.change(input, { target: { value: 'next' } });
    expect(screen.getByText('Next Image')).toBeInTheDocument();
    expect(screen.queryByText('Open File')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'file' } });
    expect(screen.getByText('Open File')).toBeInTheDocument();
  });

  it('moves active command with arrow keys and executes on Enter', async () => {
    const commands = baseCommands.map((command) => ({ ...command, run: vi.fn() }));
    const { onClose } = renderPalette(commands);
    const input = screen.getByLabelText('Search commands');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(commands[1].run).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('closes on Escape', () => {
    const { onClose } = renderPalette(baseCommands);
    const input = screen.getByLabelText('Search commands');

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides disabled commands', () => {
    const commands: ViewerCommand[] = [
      ...baseCommands,
      {
        id: 'disabled',
        label: 'Disabled Action',
        isEnabled: () => false,
        run: vi.fn(),
      },
    ];

    renderPalette(commands);

    expect(screen.queryByText('Disabled Action')).not.toBeInTheDocument();
  });
});

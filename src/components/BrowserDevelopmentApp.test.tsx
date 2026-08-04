import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserDevelopmentApp } from './BrowserDevelopmentApp';

describe('BrowserDevelopmentApp', () => {
  it('offers deterministic viewer, grid, compare, settings, and command palette journeys', () => {
    render(<BrowserDevelopmentApp />);
    expect(screen.getByText('Development / demo mode')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open demo catalog' }));
    expect(screen.getByLabelText('alpine-lake.jpg')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark favorite' }));
    expect(screen.getByRole('button', { name: 'Favorite' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByLabelText('wildflowers.jpg')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('alpine-lake.jpg')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'grid' }));
    expect(screen.getByLabelText('Demo image grid')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'compare' }));
    expect(screen.getByText('studio-light.png')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Open personal file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete or move image' })).toHaveAttribute('title');
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('keeps curation per image and resets it on remount', () => {
    const { unmount } = render(<BrowserDevelopmentApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Open demo catalog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark favorite' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Mark favorite' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('0');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('button', { name: 'Favorite' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('4');
    unmount();
    render(<BrowserDevelopmentApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Open demo catalog' }));
    expect(screen.getByRole('button', { name: 'Mark favorite' })).toBeInTheDocument();
  });

  it('moves focus into and restores it from modals without startup errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<BrowserDevelopmentApp />);
    const settings = screen.getByRole('button', { name: 'Settings' });
    settings.focus();
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(settings).toHaveFocus());
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    unmount();
  });
});

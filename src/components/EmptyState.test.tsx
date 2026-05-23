import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from './EmptyState';
import { useSettingsStore } from '../state/settingsStore';
import { DEFAULT_SETTINGS } from '../types/settings';
import { vi, describe, it, expect, beforeEach } from 'vitest';

describe('EmptyState', () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: DEFAULT_SETTINGS,
    }));
  });

  it('should call onOpenFile when Open Image button is clicked', () => {
    const onOpenFile = vi.fn();
    const onOpenFolder = vi.fn();
    render(
      <EmptyState
        onOpenFile={onOpenFile}
        onOpenFolder={onOpenFolder}
        onOpenRecentFolder={vi.fn()}
      />
    );

    const openImageBtn = screen.getByText(/Open Image/i);
    fireEvent.click(openImageBtn);

    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it('should call onOpenFolder when Open Folder button is clicked', () => {
    const onOpenFile = vi.fn();
    const onOpenFolder = vi.fn();
    render(
      <EmptyState
        onOpenFile={onOpenFile}
        onOpenFolder={onOpenFolder}
        onOpenRecentFolder={vi.fn()}
      />
    );

    const openFolderBtn = screen.getByText(/Open Folder/i);
    fireEvent.click(openFolderBtn);

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it('should display shortcut hints', () => {
    render(<EmptyState onOpenFile={vi.fn()} onOpenFolder={vi.fn()} onOpenRecentFolder={vi.fn()} />);

    expect(screen.getByText('Ctrl+O')).toBeInTheDocument();
    expect(screen.getByText('Slideshow')).toBeInTheDocument();
    expect(screen.getByText('Fullscreen')).toBeInTheDocument();
  });

  it('opens a recent folder from the landing page', () => {
    const onOpenRecentFolder = vi.fn();
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        recentFolders: [{ path: 'D:/Shoots/May', label: 'May', openedAt: 100 }],
      },
    }));

    render(
      <EmptyState
        onOpenFile={vi.fn()}
        onOpenFolder={vi.fn()}
        onOpenRecentFolder={onOpenRecentFolder}
      />
    );

    fireEvent.click(screen.getByText('May'));

    expect(onOpenRecentFolder).toHaveBeenCalledWith('D:/Shoots/May');
  });

  it('opens a recent folder directly into a saved view preset', () => {
    const onOpenRecentFolder = vi.fn();
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        recentFolders: [{ path: 'D:/Shoots/May', label: 'May', openedAt: 100 }],
        savedViewPresets: ['favorites', 'unreviewed'],
      },
    }));

    render(
      <EmptyState
        onOpenFile={vi.fn()}
        onOpenFolder={vi.fn()}
        onOpenRecentFolder={onOpenRecentFolder}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));

    expect(onOpenRecentFolder).toHaveBeenCalledWith('D:/Shoots/May', 'favorites');
  });
});

import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from './EmptyState';
import { vi, describe, it, expect } from 'vitest';

describe('EmptyState', () => {
  it('should call onOpenFile when Open Image button is clicked', () => {
    const onOpenFile = vi.fn();
    const onOpenFolder = vi.fn();
    render(<EmptyState onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} />);

    const openImageBtn = screen.getByText(/Open Image/i);
    fireEvent.click(openImageBtn);

    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it('should call onOpenFolder when Open Folder button is clicked', () => {
    const onOpenFile = vi.fn();
    const onOpenFolder = vi.fn();
    render(<EmptyState onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} />);

    const openFolderBtn = screen.getByText(/Open Folder/i);
    fireEvent.click(openFolderBtn);

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it('should display shortcut hints', () => {
    render(<EmptyState onOpenFile={vi.fn()} onOpenFolder={vi.fn()} />);
    
    expect(screen.getByText('Ctrl+O')).toBeInTheDocument();
    expect(screen.getByText('Slideshow')).toBeInTheDocument();
    expect(screen.getByText('Fullscreen')).toBeInTheDocument();
  });
});

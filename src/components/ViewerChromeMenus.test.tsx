import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MenuLabel, SlideshowOptions } from './ViewerChromeMenus';

describe('ViewerChromeMenus', () => {
  it('renders menu labels with icons and shortcuts', () => {
    render(<MenuLabel label="Open" shortcut="Ctrl+O" icon="file" />);

    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+O')).toBeInTheDocument();
  });

  it('keeps slideshow controls disabled until images are available', () => {
    const updateSettings = vi.fn().mockResolvedValue(true);
    render(
      <SlideshowOptions
        menuRef={{ current: null }}
        canStart={false}
        shuffle={false}
        direction="forward"
        repeat={false}
        interval={5}
        autoFullscreen={false}
        updateSettings={updateSettings}
      />
    );

    const trigger = screen.getByText('Slideshow options');
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

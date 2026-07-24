import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImageCaptionOverlay } from './ImageCaptionOverlay';

const caption = {
  text: 'subject token, portrait, detailed eyes, soft studio lighting',
  sidecar_path: 'C:/Training/photo.txt',
  extension: 'txt',
};

describe('ImageCaptionOverlay', () => {
  it('shows caption text and exposes an accessible disclosure', () => {
    const onExpandedChange = vi.fn();
    render(
      <ImageCaptionOverlay
        caption={caption}
        expanded={false}
        hasThumbnails={false}
        onExpandedChange={onExpandedChange}
        onCopy={vi.fn()}
      />
    );

    expect(screen.getByText(caption.text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand image caption' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand image caption' }));

    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('reflects the shared expanded state from its parent', () => {
    render(
      <ImageCaptionOverlay
        caption={caption}
        expanded
        hasThumbnails={false}
        onExpandedChange={vi.fn()}
        onCopy={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Collapse image caption' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('copies the caption and offsets itself above thumbnails', () => {
    const onCopy = vi.fn();
    const { container } = render(
      <ImageCaptionOverlay
        caption={caption}
        expanded={false}
        hasThumbnails
        onExpandedChange={vi.fn()}
        onCopy={onCopy}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy image caption' }));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(container.firstChild).toHaveClass('image-caption-overlay--with-thumbnails');
  });

  it('preserves parent-controlled expansion when navigation supplies a different sidecar', () => {
    const { rerender } = render(
      <ImageCaptionOverlay
        caption={caption}
        expanded
        hasThumbnails={false}
        onExpandedChange={vi.fn()}
        onCopy={vi.fn()}
      />
    );

    rerender(
      <ImageCaptionOverlay
        caption={{ ...caption, sidecar_path: 'C:/Training/next.txt' }}
        expanded
        hasThumbnails={false}
        onExpandedChange={vi.fn()}
        onCopy={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Collapse image caption' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});

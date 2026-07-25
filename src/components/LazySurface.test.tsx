import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LazySurface } from './LazySurface';

function LoadedSurface() {
  return <div>loaded surface</div>;
}

describe('LazySurface', () => {
  it('shows a recoverable alert and retries a rejected import', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValue({ default: LoadedSurface });
    render(<LazySurface label="Settings" loader={loader} props={{}} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Settings.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('loaded surface')).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('opens and closes repeatedly without reusing a failed surface state', async () => {
    const loader = vi.fn().mockResolvedValue({ default: LoadedSurface });
    const first = render(<LazySurface label="Contact sheet" loader={loader} props={{}} />);
    expect(await screen.findByText('loaded surface')).toBeInTheDocument();
    first.unmount();

    render(<LazySurface label="Contact sheet" loader={loader} props={{}} />);
    expect(await screen.findByText('loaded surface')).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

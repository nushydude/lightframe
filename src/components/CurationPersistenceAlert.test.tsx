import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CurationPersistenceAlert } from './CurationPersistenceAlert';

describe('CurationPersistenceAlert', () => {
  it('exposes retry and dismissal controls for persistence failures', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();

    render(
      <CurationPersistenceAlert
        message="Favorite could not be saved."
        onRetry={onRetry}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Favorite could not be saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss curation error' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps retry disabled while an asynchronous retry is pending', async () => {
    let resolveRetry: (() => void) | undefined;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        })
    );

    render(
      <CurationPersistenceAlert message="Could not save." onRetry={onRetry} onDismiss={vi.fn()} />
    );
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();

    resolveRetry?.();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
  });
});

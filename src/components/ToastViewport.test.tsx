import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastViewport } from './ToastViewport';
import { useToastStore } from '../state/toastStore';

describe('ToastViewport', () => {
  beforeEach(() => {
    vi.useRealTimers();
    useToastStore.getState().clearToasts();
  });

  it('renders stacked toasts in creation order', () => {
    useToastStore.getState().pushToast({
      title: 'First',
      kind: 'info',
      message: 'One',
      duration: 10_000,
    });
    useToastStore.getState().pushToast({
      title: 'Second',
      kind: 'success',
      message: 'Two',
      duration: 10_000,
    });

    render(<ToastViewport />);

    const notifications = screen.getAllByRole('status');
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toHaveTextContent('First');
    expect(notifications[1]).toHaveTextContent('Second');
  });

  it('auto-dismisses a toast after its duration', () => {
    vi.useFakeTimers();
    useToastStore.getState().pushToast({
      title: 'Saved',
      kind: 'success',
      message: 'Done',
      duration: 1000,
    });

    render(<ToastViewport />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismisses a toast manually', () => {
    useToastStore.getState().pushToast({
      title: 'Heads up',
      kind: 'warning',
      message: 'Check this path',
      duration: 10_000,
    });

    render(<ToastViewport />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Heads up' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('uses an assertive live region for errors', () => {
    useToastStore.getState().pushToast({
      title: 'Export failed',
      kind: 'error',
      message: 'Disk full',
      duration: 10_000,
    });

    render(<ToastViewport />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent('Export failed');
  });
});

import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThumbnailRefreshSignal } from './useThumbnailRefreshSignal';

type ThumbnailRefreshSignal = ReturnType<typeof useThumbnailRefreshSignal>;

interface ThumbnailRefreshSignalProbeProps {
  onSignal: (signal: ThumbnailRefreshSignal) => void;
}

function ThumbnailRefreshSignalProbe({ onSignal }: ThumbnailRefreshSignalProbeProps) {
  const signal = useThumbnailRefreshSignal();
  onSignal(signal);
  return null;
}

describe('useThumbnailRefreshSignal', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('reactivates after StrictMode effect replay and cleans up pending work on unmount', () => {
    let frameCallback: FrameRequestCallback | null = null;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 42;
    });
    const cancelAnimationFrame = vi.fn();
    window.requestAnimationFrame = requestAnimationFrame as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = cancelAnimationFrame as typeof window.cancelAnimationFrame;

    let signal!: ThumbnailRefreshSignal;
    const { unmount } = render(
      <StrictMode>
        <ThumbnailRefreshSignalProbe onSignal={(nextSignal) => (signal = nextSignal)} />
      </StrictMode>
    );

    expect(signal.isThumbnailConsumerActive()).toBe(true);

    act(() => signal.handleThumbnailLoaded());
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    unmount();

    expect(signal.isThumbnailConsumerActive()).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);

    act(() => frameCallback?.(0));
    act(() => signal.handleThumbnailLoaded());
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});

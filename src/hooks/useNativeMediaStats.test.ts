import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getNativeMediaStats, type NativeMediaStats } from '../services/nativeMedia';
import { useNativeMediaStats } from './useNativeMediaStats';

vi.mock('../services/nativeMedia', () => ({ getNativeMediaStats: vi.fn() }));
afterEach(() => vi.useRealTimers());

it('polls aggregates without overlapping requests, rerender feedback, or unmount timers', async () => {
  vi.useFakeTimers();
  let resolve!: (stats: NativeMediaStats) => void;
  vi.mocked(getNativeMediaStats).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const { result, rerender, unmount } = renderHook(() => useNativeMediaStats());
  rerender();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(getNativeMediaStats).toHaveBeenCalledTimes(1);
  const stats: NativeMediaStats = {
    capacity: 3,
    queueDepth: 1,
    running: 2,
    queuedByClass: [1, 0, 0, 0, 0, 0, 0],
    runningByClass: [1, 1, 0, 0, 0, 0, 0],
    canceledQueued: 4,
    canceledRunning: 2,
    coalescedConsumers: 1,
    queueWait: { sampleCount: 1, p50Ms: 2, p95Ms: 2, maxMs: 2 },
    execution: { sampleCount: 1, p50Ms: 5, p95Ms: 5, maxMs: 5 },
  };
  await act(async () => resolve(stats));
  expect(result.current).toEqual(stats);
  expect(getNativeMediaStats).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(getNativeMediaStats).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => resolve(stats));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(getNativeMediaStats).toHaveBeenCalledTimes(2);
});

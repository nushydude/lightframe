import { beforeEach, describe, expect, it, vi } from 'vitest';
import { playBoundaryBeep } from './boundaryFeedback';

describe('playBoundaryBeep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes the audio context after playback ends', async () => {
    let ended: (() => void) | undefined;
    const close = vi.fn().mockResolvedValue(undefined);
    const oscillator = {
      type: '',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        ended = listener;
      }),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const context = {
      state: 'running',
      currentTime: 0,
      destination: {},
      close,
      resume: vi.fn(),
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => ({
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      })),
    } as unknown as AudioContext;
    window.AudioContext = vi.fn(function MockAudioContext() {
      return context;
    }) as unknown as typeof AudioContext;

    await playBoundaryBeep();
    ended?.();
    await Promise.resolve();

    expect(oscillator.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function), {
      once: true,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('resumes a suspended context and absorbs resume failures while closing it', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn().mockRejectedValue(new Error('blocked'));
    const context = { state: 'suspended', close, resume } as unknown as AudioContext;
    window.AudioContext = vi.fn(function MockAudioContext() {
      return context;
    }) as unknown as typeof AudioContext;

    await expect(playBoundaryBeep()).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

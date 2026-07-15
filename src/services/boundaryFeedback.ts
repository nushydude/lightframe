async function closeAudioContext(context: AudioContext): Promise<void> {
  if (context.state === 'closed') {
    return;
  }

  try {
    await context.close();
  } catch {
    // Boundary feedback must never interfere with navigation.
  }
}

/** Play a subtle sound at a navigation boundary and release its native audio resources. */
export async function playBoundaryBeep(): Promise<void> {
  let context: AudioContext | null = null;

  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof window.AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    context = new AudioContextCtor();
    if (context.state === 'closed') {
      return;
    }
    if (context.state === 'suspended') {
      await context.resume();
    }

    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(300, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(150, context.currentTime + 0.15);
    gainNode.gain.setValueAtTime(0.2, context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.15);
    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    const playbackContext = context;
    oscillator.addEventListener('ended', () => void closeAudioContext(playbackContext), {
      once: true,
    });
    oscillator.start();
    oscillator.stop(context.currentTime + 0.15);
  } catch {
    if (context) {
      await closeAudioContext(context);
    }
  }
}

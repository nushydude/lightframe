import { useEffect, useState } from 'react';
import { getNativeMediaStats, type NativeMediaStats } from '../services/nativeMedia';

/** Poll only while diagnostics are mounted; never overlap probes or depend on their results. */
export function useNativeMediaStats() {
  const [stats, setStats] = useState<NativeMediaStats | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getNativeMediaStats();
        if (!disposed) setStats(next);
      } catch {
        // A failed probe must not interrupt the viewer.
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return stats;
}

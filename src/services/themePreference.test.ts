import { describe, expect, it, vi } from 'vitest';
import { applyThemePreference } from './themePreference';

describe('applyThemePreference', () => {
  it('follows operating-system theme changes and removes the listener on cleanup', () => {
    const root = document.createElement('html');
    const listeners = new Set<() => void>();
    const mediaQuery = {
      matches: false,
      addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: () => void) =>
        listeners.delete(listener)
      ),
    } as unknown as MediaQueryList;

    const cleanup = applyThemePreference(
      'system',
      root,
      vi.fn(() => mediaQuery)
    );
    expect(root).toHaveAttribute('data-theme', 'light');

    Object.defineProperty(mediaQuery, 'matches', { value: true, configurable: true });
    listeners.forEach((listener) => listener());
    expect(root).toHaveAttribute('data-theme', 'dark');

    cleanup();
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(listeners.size).toBe(0);
  });

  it('applies an explicit theme without subscribing to system changes', () => {
    const root = document.createElement('html');
    const matchMedia = vi.fn();

    applyThemePreference('dark', root, matchMedia);

    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(matchMedia).not.toHaveBeenCalled();
  });
});

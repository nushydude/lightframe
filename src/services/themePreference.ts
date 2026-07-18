import type { AppSettings } from '../types/settings';

const SYSTEM_DARK_THEME_QUERY = '(prefers-color-scheme: dark)';

export function applyThemePreference(
  theme: AppSettings['theme'],
  root: HTMLElement = document.documentElement,
  matchMedia: typeof window.matchMedia = window.matchMedia.bind(window)
): () => void {
  if (theme !== 'system') {
    root.setAttribute('data-theme', theme);
    return () => undefined;
  }

  const mediaQuery = matchMedia(SYSTEM_DARK_THEME_QUERY);
  const applySystemTheme = () => {
    root.setAttribute('data-theme', mediaQuery.matches ? 'dark' : 'light');
  };

  applySystemTheme();
  mediaQuery.addEventListener('change', applySystemTheme);
  return () => mediaQuery.removeEventListener('change', applySystemTheme);
}

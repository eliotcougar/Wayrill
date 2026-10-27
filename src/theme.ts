export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'wayrill.appearance.theme';
export const themeBackgrounds = { light: '#f4f6fa', dark: '#10151d' } as const;
export interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  persistenceError: string;
}
const preferenceFrom = (value: string | null): ThemePreference =>
  value === 'light' || value === 'dark' ? value : 'system';

/** Appearance is a local preference, independent of protected routing data. */
export function createThemeController(target: Window, document: Document) {
  const media = target.matchMedia?.('(prefers-color-scheme: dark)');
  let preference: ThemePreference = 'system',
    persistenceError = '';
  try {
    preference = preferenceFrom(target.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    persistenceError =
      'The saved theme could not be read. You can still choose a theme for this session.';
  }
  let snapshot: ThemeSnapshot;
  const listeners = new Set<() => void>();
  const apply = () => {
    const resolved = preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', themeBackgrounds[resolved]);
    if (
      snapshot?.preference === preference &&
      snapshot.resolved === resolved &&
      snapshot.persistenceError === persistenceError
    )
      return;
    snapshot = { preference, resolved, persistenceError };
    listeners.forEach((listener) => listener());
  };
  const systemChanged = () => apply();
  const storedChanged = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    preference = preferenceFrom(event.key === null ? null : event.newValue);
    persistenceError = '';
    apply();
  };
  media?.addEventListener('change', systemChanged);
  target.addEventListener('storage', storedChanged);
  apply();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPreference: (value: ThemePreference) => {
      preference = value;
      try {
        target.localStorage.setItem(THEME_STORAGE_KEY, value);
        persistenceError = '';
      } catch {
        persistenceError = 'Theme changed for this session, but the choice could not be saved.';
      }
      apply();
    },
    dispose() {
      media?.removeEventListener('change', systemChanged);
      target.removeEventListener('storage', storedChanged);
      listeners.clear();
    },
  };
}
let controller: ReturnType<typeof createThemeController> | undefined;
/** Called before rendering the loading screen to avoid starting with the wrong palette. */
export const initializeTheme = () => (controller ??= createThemeController(window, document));

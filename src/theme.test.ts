// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createThemeController, THEME_STORAGE_KEY } from './theme';
let dark = false;
const events = new EventTarget();
const media = {
  get matches() {
    return dark;
  },
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
} as unknown as MediaQueryList;
const controllers: ReturnType<typeof createThemeController>[] = [];
const open = () => {
  const controller = createThemeController(window, document);
  controllers.push(controller);
  return controller;
};
const system = (value: boolean) => {
  dark = value;
  events.dispatchEvent(new Event('change'));
};
beforeEach(() => {
  localStorage.clear();
  dark = false;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  document.head.innerHTML = '<meta name="theme-color" content="#000">';
});
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty('color-scheme');
});
it('keeps the theme usable when storage is unavailable and reports persistence failure', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('blocked');
  });
  const c = open();
  expect(c.getSnapshot().persistenceError).toContain('could not be read');
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('quota');
  });
  c.setPreference('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(c.getSnapshot().persistenceError).toContain('could not be saved');
  write.mockRestore();
  c.setPreference('light');
  expect(c.getSnapshot().persistenceError).toBe('');
});
it('removes system and storage subscriptions when disposed', () => {
  const c = open(),
    listener = vi.fn();
  c.subscribe(listener);
  c.dispose();
  system(true);
  window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }));
  expect(listener).not.toHaveBeenCalled();
});

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
it('defaults to System and applies the current palette before rendering', () => {
  const c = open();
  expect(c.getSnapshot()).toEqual({
    preference: 'system',
    resolved: 'light',
    persistenceError: '',
  });
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.documentElement.style.colorScheme).toBe('light');
  const lightColor = document.querySelector('meta')!.content;
  expect(lightColor).not.toBe('#000');
  system(true);
  expect(c.getSnapshot().resolved).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.querySelector('meta')!.content).not.toBe(lightColor);
});
it('persists an explicit choice and ignores system changes until System is selected', () => {
  const c = open(),
    listener = vi.fn();
  c.subscribe(listener);
  c.setPreference('dark');
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  system(true);
  system(false);
  expect(c.getSnapshot().resolved).toBe('dark');
  expect(listener).toHaveBeenCalledTimes(1);
  c.dispose();
  const reopened = open();
  expect(reopened.getSnapshot().preference).toBe('dark');
  reopened.setPreference('system');
  expect(reopened.getSnapshot().resolved).toBe('light');
  system(true);
  expect(reopened.getSnapshot().resolved).toBe('dark');
});
it('treats invalid saved preferences as System', () => {
  localStorage.setItem(THEME_STORAGE_KEY, 'unexpected');
  dark = true;
  expect(open().getSnapshot()).toMatchObject({ preference: 'system', resolved: 'dark' });
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
it('follows appearance changes from another window and ignores unrelated storage events', () => {
  const c = open();
  window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'dark' }));
  expect(c.getSnapshot().preference).toBe('system');
  window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }));
  expect(c.getSnapshot()).toMatchObject({ preference: 'dark', resolved: 'dark' });
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  expect(c.getSnapshot()).toMatchObject({ preference: 'system', resolved: 'light' });
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

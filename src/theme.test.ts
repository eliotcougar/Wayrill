// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createThemeController } from './theme';
const events = new EventTarget();
const media = {
  matches: false,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
} as unknown as MediaQueryList;
let controller: ReturnType<typeof createThemeController>;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  document.head.innerHTML = '<meta name="theme-color" content="#000">';
});
afterEach(() => {
  controller?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty('color-scheme');
});
it('keeps the theme usable when storage is unavailable and reports persistence failure', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('blocked');
  });
  controller = createThemeController(window, document);
  expect(controller.getSnapshot().persistenceError).toContain('could not be read');
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('quota');
  });
  controller.setPreference('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(controller.getSnapshot().persistenceError).toContain('could not be saved');
  write.mockRestore();
  controller.setPreference('light');
  expect(controller.getSnapshot().persistenceError).toBe('');
});

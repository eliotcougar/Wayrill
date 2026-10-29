// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { validatePreferences, writePreferences } from './preferences';
import { THEME_STORAGE_KEY } from '../theme';
import { testSettingsKey, defaultTestSettings } from '../outboundTestSettings';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it('rolls back writes if the workspace cannot accept restoration', () => {
  localStorage.setItem(THEME_STORAGE_KEY, 'light');
  const saved = writePreferences({
    [THEME_STORAGE_KEY]: 'dark',
    [testSettingsKey]: JSON.stringify(defaultTestSettings),
  });
  saved.rollback();
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  expect(localStorage.getItem(testSettingsKey)).toBeNull();
  expect(() =>
    validatePreferences({
      [testSettingsKey]: JSON.stringify({ ...defaultTestSettings, testUrl: 'file:///private' }),
    }),
  ).toThrow();
});

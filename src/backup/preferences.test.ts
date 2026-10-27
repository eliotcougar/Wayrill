// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readPreferences, validatePreferences, writePreferences } from './preferences';
import { THEME_STORAGE_KEY } from '../theme';
import { testSettingsKey, defaultTestSettings } from '../outboundTestSettings';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it('captures the effective outbound test settings, including currently inherited values', () => {
  localStorage.setItem(
    testSettingsKey,
    JSON.stringify({ testUrl: 'https://example.test/delay', countryUrl: '' }),
  );
  expect(JSON.parse(readPreferences()[testSettingsKey]!)).toEqual({
    ...defaultTestSettings,
    testUrl: 'https://example.test/delay',
    countryUrl: '',
  });
});
it('restores only the allowlisted preferences and notifies observers after commit', () => {
  localStorage.setItem(THEME_STORAGE_KEY, 'light');
  localStorage.setItem('foreign.setting', 'keep');
  const changed = vi.fn();
  window.addEventListener('storage', changed);
  const saved = writePreferences({
    [THEME_STORAGE_KEY]: 'dark',
    [testSettingsKey]: JSON.stringify(defaultTestSettings),
  });
  expect(changed).not.toHaveBeenCalled();
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  saved.commit();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(readPreferences()[THEME_STORAGE_KEY]).toBe('dark');
  expect(localStorage.getItem('foreign.setting')).toBe('keep');
  window.removeEventListener('storage', changed);
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

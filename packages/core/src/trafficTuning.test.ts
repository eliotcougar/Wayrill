import { expect, it } from 'vitest';
import { clearJsonUserAgents, normalizeUserAgent } from './trafficTuning';
import type { SettingValue } from './settings';

it.each([
  ['headers', { 'uSeR-aGeNt': 'Edited', 'X-QA': 'retained' }, { 'X-QA': 'retained' }],
  [
    'rawHeader',
    {
      type: 'http',
      request: { path: ['/qa'], headers: { 'User-Agent': ['Edited'], Host: ['example.test'] } },
    },
    { type: 'http', request: { path: ['/qa'], headers: { Host: ['example.test'] } } },
  ],
  [
    'xhttpExtra',
    { headers: { 'User-Agent': 'Edited', 'X-QA': 'retained' }, xmux: { maxConnections: '2-4' } },
    { headers: { 'X-QA': 'retained' }, xmux: { maxConnections: '2-4' } },
  ],
] as const)(
  'synchronizes an edited %s User-Agent without losing other transport options',
  (key, input, expected) => {
    const settings: Record<string, SettingValue> = {
      [key]: JSON.stringify(input),
      userAgent: 'Inherited',
    };
    const normalized = normalizeUserAgent(settings, key);
    expect(normalized.found).toBe(true);
    expect(normalized.settings.userAgent).toBe('Edited');
    expect(JSON.parse(String(normalized.settings[key]))).toEqual(expected);
    const cleared = clearJsonUserAgents(settings);
    expect(JSON.parse(String(cleared[key]))).toEqual(expected);
    expect(JSON.parse(String(settings[key]))).toEqual(input);
  },
);

it('retains multivalue RAW headers and invalid drafts when the named User-Agent changes', () => {
  const settings = {
    rawHeader: '{"request":{"headers":{"User-Agent":["first","second"],"Host":["example.test"]}}}',
    headers: '{unfinished',
    userAgent: 'Inherited',
  };
  expect(normalizeUserAgent(settings, 'rawHeader')).toEqual({
    found: true,
    settings: { ...settings, userAgent: '' },
  });
  expect(normalizeUserAgent(settings, 'headers')).toEqual({ found: false, settings });
  expect(clearJsonUserAgents(settings)).toMatchObject({
    headers: '{unfinished',
    userAgent: 'Inherited',
    rawHeader: '{"request":{"headers":{"Host":["example.test"]}}}',
  });
});

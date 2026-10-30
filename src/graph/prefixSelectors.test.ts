import { expect, it } from 'vitest';
import { compactSelectors } from './prefixSelectors';

it('keeps later private telemetry outbounds outside compacted selectors', () => {
  const selected = Array.from({ length: 128 }, (_, i) => `wtarg-${i}`);
  const all = [...selected, 'block'];
  const prefixes = compactSelectors(selected, all);
  expect(prefixes).toEqual(['wta']);
  expect(prefixes.some((prefix) => 'wt-metrics'.startsWith(prefix))).toBe(false);
});

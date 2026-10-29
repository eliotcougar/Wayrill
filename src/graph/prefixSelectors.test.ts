import { expect, it } from 'vitest';
import { compactSelectors } from './prefixSelectors';

it('keeps later private telemetry outbounds outside compacted selectors', () => {
  const selected = Array.from({ length: 128 }, (_, i) => `wayrill-target-${i}`);
  const all = [...selected, 'block'];
  const prefixes = compactSelectors(selected, all);
  expect(prefixes).toEqual(['wayrill-ta']);
  expect(prefixes.some((prefix) => 'wayrill-telemetry-metrics'.startsWith(prefix))).toBe(false);
});

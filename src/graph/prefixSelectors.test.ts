import { expect, it } from 'vitest';
import { compactSelectors, prefixMatches } from './prefixSelectors';

it('selects exactly the intended subset in overlapping, Unicode and generated tag sets', () => {
  const all = [
    'a',
    'a-extra',
    'b',
    'b-extra',
    'JP 東京',
    'JP 大阪',
    '😀 Tokyo',
    '😎 Paris',
    'wayrill-policy-inner-a',
    ...Array.from(
      { length: 2000 },
      (_, i) => `wayrill-policy-profile-${i.toString().padStart(4, '0')}`,
    ),
  ];
  const selected = all.filter(
    (t, i) =>
      (t.startsWith('wayrill-policy-profile-') && i % 3 !== 0) ||
      t === 'b-extra' ||
      t === 'JP 東京' ||
      t === '😀 Tokyo',
  );
  const prefixes = compactSelectors(selected, all);
  expect(all.filter((t) => prefixes.some((p) => t.startsWith(p)))).toEqual(selected);
  expect(prefixes.every((p) => p.length > 0)).toBe(true);
  expect(prefixes).toContain('😀');
});
it('compresses a large isolated generated set without including fallback or inner stages', () => {
  const selected = Array.from(
    { length: 16380 },
    (_, i) => `wayrill-policy-profile-${i.toString().padStart(5, '0')}`,
  );
  const all = [
    ...selected,
    'wayrill-runtime-unmatched',
    'wayrill-policy-inner-a',
    'direct',
    'block',
  ];
  expect(compactSelectors(selected, all)).toEqual(['wayrill-policy-p']);
  expect(() => compactSelectors(['a'], ['a', 'a-extra'])).toThrow(/exact member set/);
  expect(prefixMatches(['a', 'a-extra', 'c'], 'b')).toBe(false);
});

it('keeps later private telemetry outbounds outside compacted selectors', () => {
  const selected = Array.from({ length: 128 }, (_, i) => `wayrill-target-${i}`);
  const all = [...selected, 'block'];
  const prefixes = compactSelectors(selected, all);
  expect(prefixes).toEqual(['wayrill-ta']);
  expect(prefixes.some((prefix) => 'wayrill-telemetry-metrics'.startsWith(prefix))).toBe(false);
});

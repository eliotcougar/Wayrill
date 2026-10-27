import { expect, it } from 'vitest';
import {
  sortTrafficEndpoints,
  loadTrafficSortPreferences,
  saveTrafficSortPreferences,
  TRAFFIC_SORTING_KEY,
} from './trafficSorting';
import type { TrafficEndpoint, TrafficSortColumn } from './traffic';
const rows: TrafficEndpoint[] = [
  {
    scope: 'outbound',
    tag: 'a',
    uploadBytes: '9007199254740993',
    downloadBytes: '2',
    uploadPerSecond: null,
    downloadPerSecond: 0,
  },
  {
    scope: 'outbound',
    tag: 'z',
    uploadBytes: '9007199254740992',
    downloadBytes: '900000',
    uploadPerSecond: 2,
    downloadPerSecond: 10000,
  },
  {
    scope: 'outbound',
    tag: 'm',
    uploadBytes: '340282366920938463463374607431768211455',
    downloadBytes: '10',
    uploadPerSecond: 0,
    downloadPerSecond: 2,
  },
];
const names = { inbound: {}, outbound: { a: 'Zulu', z: 'alpha', m: 'ALPHA' } };
it.each([
  ['name', ['m', 'z', 'a'], ['a', 'm', 'z']],
  ['uploadBytes', ['z', 'a', 'm'], ['m', 'a', 'z']],
  ['downloadBytes', ['a', 'm', 'z'], ['z', 'm', 'a']],
  ['uploadPerSecond', ['m', 'z', 'a'], ['z', 'm', 'a']],
  ['downloadPerSecond', ['a', 'm', 'z'], ['z', 'm', 'a']],
] as [TrafficSortColumn, string[], string[]][])(
  'sorts %s using measurements, exact totals and stable label/tag ties',
  (column, asc, desc) => {
    expect(
      sortTrafficEndpoints(rows, { column, direction: 'asc' }, names).map((r) => r.tag),
    ).toEqual(asc);
    expect(
      sortTrafficEndpoints(rows, { column, direction: 'desc' }, names).map((r) => r.tag),
    ).toEqual(desc);
    expect(rows.map((r) => r.tag)).toEqual(['a', 'z', 'm']);
  },
);
it('keeps missing and invalid rates after measured zero in both directions', () => {
  const endpoints = rows.map((row, i) => ({ ...row, uploadPerSecond: [NaN, -1, 0][i] }));
  for (const direction of ['asc', 'desc'] as const) {
    expect(
      sortTrafficEndpoints(endpoints, { column: 'uploadPerSecond', direction }, names).map(
        (r) => r.tag,
      ),
    ).toEqual(['m', 'z', 'a']);
    expect(
      sortTrafficEndpoints(rows, { column: 'uploadPerSecond', direction }, names, false).map(
        (r) => r.tag,
      ),
    ).toEqual(['m', 'z', 'a']);
  }
});
it('orders case-insensitive Unicode names consistently with native paging', () => {
  const endpoints = ['🚀', '\uE000', 'Я', 'α', 'b', 'A'].map((tag) => ({ ...rows[0], tag }));
  expect(
    sortTrafficEndpoints(endpoints, { column: 'name', direction: 'asc' }).map((r) => r.tag),
  ).toEqual(['A', 'b', 'α', 'Я', '\uE000', '🚀']);
});

it('retains independent sort preferences without changing unit preferences', () => {
  const values = new Map([['wayrill.traffic.units', '{"rate":"bits","amount":"bytes"}']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const sorts = {
    inbound: { column: 'name', direction: 'desc' },
    outbound: { column: 'downloadBytes', direction: 'desc' },
  } as const;
  expect(saveTrafficSortPreferences(sorts, storage)).toBe('');
  expect(loadTrafficSortPreferences(storage)).toEqual({ sorts, error: '' });
  expect(values.get('wayrill.traffic.units')).toBe('{"rate":"bits","amount":"bytes"}');
  values.set(
    TRAFFIC_SORTING_KEY,
    '{"inbound":{"column":"invalid","direction":"asc"},"outbound":{"column":"downloadBytes","direction":"desc"}}',
  );
  expect(loadTrafficSortPreferences(storage).sorts).toEqual({
    inbound: { column: 'name', direction: 'asc' },
    outbound: sorts.outbound,
  });
});
it('keeps sorting usable when preference storage is corrupt or unavailable', () => {
  const defaults = {
    inbound: { column: 'name', direction: 'asc' },
    outbound: { column: 'name', direction: 'asc' },
  } as const;
  expect(loadTrafficSortPreferences({ getItem: () => '{broken' }).sorts).toEqual(defaults);
  expect(
    loadTrafficSortPreferences({
      getItem: () => {
        throw new Error('unavailable');
      },
    }).error,
  ).toBeTruthy();
  expect(
    saveTrafficSortPreferences(defaults, {
      setItem: () => {
        throw new Error('unavailable');
      },
    }),
  ).toContain('could not be saved');
});

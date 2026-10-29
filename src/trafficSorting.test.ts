import { expect, it } from 'vitest';
import {
  sortTrafficEndpoints,
  loadTrafficSortPreferences,
  saveTrafficSortPreferences,
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

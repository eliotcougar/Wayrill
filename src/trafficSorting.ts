import { endpointDisplayName, type DisplayNames } from './graph/displayNames';
import type { TrafficEndpoint, TrafficSort, TrafficSortColumn } from './traffic';
import { jsonRecord, parseJson } from './graph/xrayJson';

export const defaultTrafficSort: TrafficSort = { column: 'name', direction: 'asc' };

// Match the service's Unicode code-point order, independent of the Windows locale.
function compareText(a: string, b: string): number {
  const left = Array.from(a),
    right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}

/** Sort a complete small snapshot; large sets are sorted by the service before paging. */
export function sortTrafficEndpoints(
  rows: readonly TrafficEndpoint[],
  sort: TrafficSort,
  names?: DisplayNames,
  ratesAvailable = true,
): TrafficEndpoint[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((row) => {
      const name = endpointDisplayName(names, row.scope, row.tag).toLowerCase();
      let value: string | bigint | number | null;
      if (sort.column === 'name') value = name;
      else if (sort.column === 'uploadBytes' || sort.column === 'downloadBytes') {
        const count = row[sort.column];
        value = /^\d+$/.test(count) ? BigInt(count) : null;
      } else {
        const rate = row[sort.column];
        value = ratesAvailable && rate != null && Number.isFinite(rate) && rate >= 0 ? rate : null;
      }
      return { row, name, value };
    })
    .sort((a, b) => {
      // Missing measurements are last in both directions; measured zero stays sortable.
      if (a.value == null && b.value != null) return 1;
      if (a.value != null && b.value == null) return -1;
      const order =
        typeof a.value === 'string' && typeof b.value === 'string'
          ? compareText(a.value, b.value)
          : a.value != null && b.value != null
            ? a.value < b.value
              ? -1
              : a.value > b.value
                ? 1
                : 0
            : 0;
      return direction * order || compareText(a.name, b.name) || compareText(a.row.tag, b.row.tag);
    })
    .map(({ row }) => row);
}

export const TRAFFIC_SORTING_KEY = 'wayrill.traffic.sorting';
export type TrafficSortPreferences = Record<'inbound' | 'outbound', TrafficSort>;
const columns = new Set<TrafficSortColumn>([
  'name',
  'uploadPerSecond',
  'downloadPerSecond',
  'uploadBytes',
  'downloadBytes',
]);
function storedSort(value: unknown): TrafficSort {
  return jsonRecord(value) &&
    typeof value.column === 'string' &&
    columns.has(value.column as TrafficSortColumn) &&
    (value.direction === 'asc' || value.direction === 'desc')
    ? { column: value.column as TrafficSortColumn, direction: value.direction }
    : { ...defaultTrafficSort };
}
export function loadTrafficSortPreferences(storage?: Pick<Storage, 'getItem'>): {
  sorts: TrafficSortPreferences;
  error: string;
} {
  try {
    const value = parseJson((storage ?? window.localStorage).getItem(TRAFFIC_SORTING_KEY) ?? '{}');
    const saved = jsonRecord(value) ? value : {};
    return {
      sorts: { inbound: storedSort(saved.inbound), outbound: storedSort(saved.outbound) },
      error: '',
    };
  } catch {
    return {
      sorts: { inbound: { ...defaultTrafficSort }, outbound: { ...defaultTrafficSort } },
      error: 'Saved sorting preferences could not be read.',
    };
  }
}
export function saveTrafficSortPreferences(
  sorts: TrafficSortPreferences,
  storage?: Pick<Storage, 'setItem'>,
): string {
  try {
    (storage ?? window.localStorage).setItem(TRAFFIC_SORTING_KEY, JSON.stringify(sorts));
    return '';
  } catch {
    return 'Sorting changed, but the preference could not be saved.';
  }
}

import { intersectNativeProcesses, intersectProtocolPrefixes } from './nativePredicates';
import { effectiveRoutingFields } from './routingFields';
import { jsonEqual, jsonArray, xrayStringList } from './xrayJson';
import { subnet } from './ipNetwork';

type Fields = Record<string, unknown>;
const sets = new Set(['inboundTag', 'user', 'protocol', 'process', 'localOS']);
const ports = new Set(['port', 'sourcePort', 'localPort', 'vlessRoute']);
const ips = new Set(['ip', 'sourceIP', 'localIP']);
export const routingPredicateKeys: ReadonlySet<string> = new Set([
  ...sets,
  ...ports,
  ...ips,
  'domain',
  'domains',
  'source',
  'network',
  'attrs',
  '_wayrillApplications',
]);
// Native Xray lists accept both arrays and comma-separated strings. Normalize
// only for intersection; untouched imported rules retain their original JSON.
const array = (v: unknown): string[] => xrayStringList(v).map(String);
const networks = (v: unknown) => array(v).map((network) => network.toLowerCase());
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));
function ranges(v: unknown): [number, number][] {
  return String(v)
    .split(',')
    .map((s) => {
      const [a, b = a] = s.trim().split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > 65535 || a > b)
        throw new Error('Invalid range in a routing predicate.');
      return [a, b];
    });
}
function intersectRanges(a: unknown, b: unknown): string | null {
  const intersections: [number, number][] = [];
  for (const [al, ah] of ranges(a))
    for (const [bl, bh] of ranges(b)) {
      const low = Math.max(al, bl),
        high = Math.min(ah, bh);
      if (low <= high) intersections.push([low, high]);
    }
  intersections.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const range of intersections) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged.length
    ? merged.map(([l, h]) => (l === h ? String(l) : `${l}-${h}`)).join(',')
    : null;
}
function domain(text: string): { kind: 'full' | 'domain'; value: string } | undefined {
  const match = /^(full|domain):(.+)$/.exec(text);
  return match ? { kind: match[1] as 'full' | 'domain', value: match[2].toLowerCase() } : undefined;
}
function suffix(name: string, parent: string) {
  return name === parent || name.endsWith(`.${parent}`);
}
// Each list is OR; a path is AND. Never turn (A OR B) AND (C OR D) into a union.
function intersectLists(
  a: string[],
  b: string[],
  field: string,
  maxTerms: number,
): string[] | null {
  if (sameSet(a, b)) return a;
  const result = new Set<string>();
  for (const x of a)
    for (const y of b) {
      if (x === y) result.add(x);
      else if (ips.has(field)) {
        const sx = subnet(x),
          sy = subnet(y);
        if (!sx || !sy) throw new Error('Opaque GeoIP or negated IP predicates');
        if (sx.family === sy.family && sx.low <= sy.high && sy.low <= sx.high)
          result.add(sx.low >= sy.low && sx.high <= sy.high ? x : y);
      } else {
        const dx = domain(x),
          dy = domain(y);
        if (!dx || !dy) throw new Error('Opaque domain, regexp, keyword or geosite predicates');
        if (dx.kind === 'full' && dy.kind === 'full') {
          if (dx.value === dy.value) result.add(x);
        } else if (dx.kind === 'full') {
          if (suffix(dx.value, dy.value)) result.add(x);
        } else if (dy.kind === 'full') {
          if (suffix(dy.value, dx.value)) result.add(y);
        } else if (suffix(dx.value, dy.value)) result.add(x);
        else if (suffix(dy.value, dx.value)) result.add(y);
      }
      if (result.size > maxTerms) throw new Error('Predicate expansion exceeds its term budget');
    }
  return result.size ? [...result] : null;
}
export function intersectPredicates(a: Fields, b: Fields, maxTerms: number): Fields | null {
  // A native alias must not override a parent condition after flattening. Keep
  // untouched root rules exact; canonicalize only when combining that predicate.
  if (
    [
      ['domain', 'domains'],
      ['sourceIP', 'source'],
    ].some(
      (keys) =>
        keys.some((key) => Object.hasOwn(a, key)) && keys.some((key) => Object.hasOwn(b, key)),
    )
  ) {
    a = effectiveRoutingFields(a);
    b = effectiveRoutingFields(b);
    for (const fields of [a, b]) {
      delete fields.domains;
      delete fields.source;
    }
  }
  const result = new Map(Object.entries(a));
  const empty = (v: unknown) => v === null || (jsonArray(v) && !v.length);
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    if (!result.has(key)) {
      result.set(key, value);
      continue;
    }
    // Empty native matcher lists add no condition in Xray. Their conjunction is
    // the other predicate, rather than an empty intersection that drops a path.
    if (routingPredicateKeys.has(key) && empty(value)) continue;
    const old = result.get(key);
    if (routingPredicateKeys.has(key) && empty(old)) {
      result.set(key, value);
      continue;
    }
    if (jsonEqual(old, value)) continue;
    let intersection: unknown;
    if (key === '_wayrillApplications')
      intersection = [...new Set([...array(old), ...array(value)])];
    else if (ports.has(key)) intersection = intersectRanges(old, value);
    else if (key === 'process')
      intersection = intersectNativeProcesses(array(old), array(value), maxTerms);
    else if (key === 'protocol')
      intersection = intersectProtocolPrefixes(array(old), array(value), maxTerms);
    else if (sets.has(key) || key === 'network') {
      const lhs = key === 'network' ? networks(old) : array(old),
        rhs = key === 'network' ? networks(value) : array(value),
        overlap = lhs.filter((v) =>
          rhs.some((r) => (key === 'localOS' ? r.toLowerCase() === v.toLowerCase() : r === v)),
        );
      intersection = overlap.length ? (key === 'network' ? overlap.join(',') : overlap) : null;
    } else if (ips.has(key) || key === 'domain')
      intersection = intersectLists(array(old), array(value), key, maxTerms);
    else if (key === 'attrs') {
      const attributes = new Map(Object.entries(old as Fields));
      for (const [name, pattern] of Object.entries(value as Fields)) {
        if (attributes.has(name) && !jsonEqual(attributes.get(name), pattern))
          throw new Error(`Different expressions for HTTP attribute ${name}`);
        attributes.set(name, pattern);
      }
      intersection = Object.fromEntries(attributes);
    } else throw new Error(`Different native ${key} values`);
    if (intersection === null) return null;
    result.set(key, intersection);
  }
  return Object.fromEntries(result);
}

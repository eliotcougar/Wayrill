import { jsonArray, jsonRecord } from './xrayJson';
export interface ApplicationSelector {
  kind: 'process' | 'package' | 'service';
  value: string;
  mode: 'name' | 'path' | 'folder';
  children: boolean;
  enabled: boolean;
}
export function parseApplicationSelectors(raw: unknown): ApplicationSelector[] {
  if (!jsonArray(raw) || raw.length > 4096)
    throw new Error('Choose at most 4,096 application selectors.');
  for (const row of raw) {
    if (
      !jsonRecord(row) ||
      typeof row.kind !== 'string' ||
      typeof row.mode !== 'string' ||
      !['process', 'package', 'service'].includes(row.kind) ||
      typeof row.value !== 'string' ||
      !row.value.trim() ||
      row.value.length > 4096 ||
      [...row.value].some((character) => character.charCodeAt(0) < 32) ||
      !['name', 'path', 'folder'].includes(row.mode) ||
      typeof row.children !== 'boolean' ||
      typeof row.enabled !== 'boolean' ||
      (row.kind === 'service' && row.children) ||
      (row.kind !== 'process' && row.mode !== 'name')
    )
      throw new Error('Invalid process, Windows app or service selector.');
    if (
      row.kind === 'process' &&
      row.mode !== 'name' &&
      !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(row.value)
    )
      throw new Error('Executable and folder paths must be absolute.');
  }
  return raw as ApplicationSelector[];
}
export function nativeProcessSelectors(values: string[]): ApplicationSelector[] {
  return values.map((value) => ({
    kind: 'process',
    value,
    mode:
      value.endsWith('/') || value.endsWith('\\')
        ? 'folder'
        : /[\\/]/.test(value)
          ? 'path'
          : 'name',
    children: false,
    enabled: true,
  }));
}
const normalized = (s: ApplicationSelector) =>
  s.value
    .toLowerCase()
    .replaceAll('\\', '/')
    .replace(/\.exe$/, '');
/** False only when two scalar identities provably cannot match the same process.
 * Children/different identity kinds remain compatible; this safely over-approximates real masks. */
export function compatible(a: ApplicationSelector, b: ApplicationSelector): boolean {
  if (a.children || b.children || a.kind !== b.kind) return true;
  const x = normalized(a),
    y = normalized(b);
  if (a.kind !== 'process' || (a.mode === 'name' && b.mode === 'name')) return x === y;
  if (a.mode === 'folder' || b.mode === 'folder') {
    if (a.mode === 'name' || b.mode === 'name') return true;
    const folder = (v: string) => v.replace(/\/$/, '') + '/';
    return (
      (a.mode === 'folder' && folder(y).startsWith(folder(x))) ||
      (b.mode === 'folder' && folder(x).startsWith(folder(y)))
    );
  }
  if (a.mode === 'name') return x === y.split('/').at(-1);
  if (b.mode === 'name') return y === x.split('/').at(-1);
  return x === y;
}
export function selectorKey(rows: ApplicationSelector[]): string {
  return JSON.stringify(
    rows
      .filter((r) => r.enabled)
      .map((r) => ({ ...r, value: r.value.trim().replaceAll('\\', '/').toLowerCase() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}
export const MAX_PROCESS_PREDICATES = 768;
export const MAX_PROCESS_PROFILES = 4096;
export function processProfiles(predicates: ApplicationSelector[][]): string[] {
  if (predicates.length > MAX_PROCESS_PREDICATES)
    throw new Error('Use at most 768 distinct Windows application conditions.');
  const digits = Math.max(1, Math.ceil(predicates.length / 4));
  const results: string[] = [];
  const pair = predicates.map((a) =>
    predicates.map((b) => a.some((x) => b.some((y) => compatible(x, y)))),
  );
  const walk = (next: number, selected: number[], mask: bigint) => {
    results.push(mask.toString(16).padStart(digits, '0'));
    if (results.length > MAX_PROCESS_PROFILES)
      throw new Error(
        'Overlapping Windows application conditions exceed 4,096 identity profiles. Combine redundant child-process conditions.',
      );
    for (let i = next; i < predicates.length; i++)
      if (selected.every((j) => pair[i][j]))
        walk(i + 1, [...selected, i], mask | (1n << BigInt(i)));
  };
  walk(0, [], 0n);
  return results;
}
export function processMaskPattern(required: number[], count: number, width?: number): string {
  const digits = width ?? Math.max(1, Math.ceil(count / 4));
  const mask = required
    .reduce((a, i) => a | (1n << BigInt(i)), 0n)
    .toString(16)
    .padStart(digits, '0');
  const pattern = [...mask]
    .map((c) => {
      const bits = parseInt(c, 16);
      return bits === 0
        ? '[0-9a-f]'
        : '[' +
            [...'0123456789abcdef'].filter((v) => (parseInt(v, 16) & bits) === bits).join('') +
            ']';
    })
    .join('');
  return `regexp:^wr-${pattern}-[0-9a-f]{48}$`;
}

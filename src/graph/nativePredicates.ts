import { LIMITS } from '../limits';

// Match the pinned Xray ProcessNameMatcher on Windows. These are OR lists;
// their conjunction must never become a broader union.
function process(value: string) {
  if (value === 'self/' || value === 'xray/') return { kind: 'runtime', value } as const;
  const path = value.replaceAll('\\', '/');
  if (path.endsWith('/')) return { kind: 'folder', value: path } as const;
  if (path.includes('/')) return { kind: 'path', value: path } as const;
  return { kind: 'name', value: path.replace(/\.exe$/, '') } as const;
}
function processPair(a: string, b: string): string | null {
  const x = process(a),
    y = process(b);
  if (x.kind === y.kind && x.value === y.value) return a;
  if (x.kind === 'runtime' || y.kind === 'runtime')
    throw new Error('Runtime process aliases cannot be combined with another process predicate');
  if (x.kind === 'name' && y.kind === 'name') return null;
  if (x.kind === 'path' && y.kind === 'path') return null;
  if (x.kind === 'folder' && y.kind === 'folder')
    return x.value.startsWith(y.value) ? a : y.value.startsWith(x.value) ? b : null;
  if (x.kind === 'path' && y.kind === 'folder') return x.value.startsWith(y.value) ? a : null;
  if (x.kind === 'folder' && y.kind === 'path') return y.value.startsWith(x.value) ? b : null;
  const name = x.kind === 'name' ? x : y;
  const path = x.kind === 'name' ? y : x;
  if (path.kind === 'folder')
    throw new Error(
      'A process name AND folder cannot be represented in one native Xray process list',
    );
  return path.value.slice(path.value.lastIndexOf('/') + 1).replace(/\.exe$/, '') === name.value
    ? x.kind === 'path'
      ? a
      : b
    : null;
}
export function intersectNativeProcesses(a: string[], b: string[]): string[] | null {
  const result = new Set<string>();
  for (const x of a)
    for (const y of b) {
      const intersection = processPair(x, y);
      if (intersection !== null) result.add(intersection);
      if (result.size > LIMITS.maxPredicateTerms)
        throw new Error('Process predicate term budget exceeded');
    }
  return result.size ? [...result] : null;
}
export function intersectProtocolPrefixes(a: string[], b: string[]): string[] | null {
  const result = new Set<string>();
  for (const x of a)
    for (const y of b) {
      if (x.startsWith(y)) result.add(x);
      else if (y.startsWith(x)) result.add(y);
      if (result.size > LIMITS.maxPredicateTerms)
        throw new Error('Protocol predicate term budget exceeded');
    }
  return result.size ? [...result] : null;
}

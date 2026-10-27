import type { ApplicationSelector } from '../graph/applications';
import type { WindowsCatalog } from './useWindowsCatalog';

const normalized = (value: string) => value.trim().replaceAll('\\', '/').toLowerCase();
const executableName = (value: string) => normalized(value).replace(/\.exe$/, '');
const systemProcesses = new Set([
  'system',
  'system idle process',
  'secure system',
  'registry',
  'memory compression',
]);
export function applicationChoices(
  catalog: WindowsCatalog | null,
  rows: ApplicationSelector[],
  kind: ApplicationSelector['kind'],
  mode: ApplicationSelector['mode'],
) {
  const choices =
    kind === 'package'
      ? (catalog?.packages ?? []).map((p) => ({ value: p.family, name: p.name, detail: p.family }))
      : kind === 'service'
        ? (catalog?.services ?? []).map((p) => ({
            value: p.name,
            name: p.displayName,
            detail: p.name,
          }))
        : (catalog?.processes ?? [])
            .filter(
              (p) => !systemProcesses.has(executableName(p.name)) && (mode === 'name' || p.path),
            )
            .filter(
              (p) =>
                !rows.some((r) => {
                  if (r.kind !== 'process') return false;
                  if (r.mode === 'name') return executableName(r.value) === executableName(p.name);
                  if (!p.path) return false;
                  return r.mode === 'path'
                    ? normalized(r.value) === normalized(p.path)
                    : normalized(p.path).startsWith(normalized(r.value).replace(/\/$/, '') + '/');
                }),
            )
            .map((p) => ({
              name: p.name,
              detail: p.path ?? 'Path unavailable',
              value:
                mode === 'name'
                  ? p.name
                  : mode === 'folder'
                    ? p.path!.replace(/[^\\/]+$/, '')
                    : p.path!,
            }));
  return [
    ...new Map(
      choices
        .filter(
          (p) =>
            kind === 'process' ||
            !rows.some((r) => r.kind === kind && normalized(r.value) === normalized(p.value)),
        )
        .map((p) => [normalized(p.name + '|' + p.detail), p]),
    ).values(),
  ];
}

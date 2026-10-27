import type { TableRule } from './rules';
import type { ListEdits, RuleEdits } from './ruleSourceModel';
const unique = <T>(rows: T[], key: (row: T) => string) => [
  ...new Map(rows.map((row) => [key(row), row])).values(),
];
export function sourceEntryKey(value: string, kind: string) {
  const text = value.trim();
  // Regexp/keyword literals and external file spellings are deliberately not folded.
  return kind === 'domain' && /^(?:full:|domain:)/i.test(text) ? text.toLowerCase() : text;
}
export const sourceEntries = (text: string, kind: string) =>
  unique(
    text
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean),
    (v) => sourceEntryKey(v, kind),
  );

function listEdit(
  previous: ListEdits | undefined,
  before: string[],
  after: string[],
  base: string[],
  kind: string,
): ListEdits | undefined {
  const key = (v: string) => sourceEntryKey(v, kind),
    added = new Map((previous?.added ?? []).map((v) => [key(v), v])),
    removed = new Map((previous?.removed ?? []).map((v) => [key(v), v])),
    old = new Set(before.map(key)),
    next = new Set(after.map(key)),
    source = new Set(base.map(key));
  for (const value of before)
    if (!next.has(key(value))) {
      added.delete(key(value));
      if (source.has(key(value))) removed.set(key(value), value);
    }
  for (const value of after)
    if (!old.has(key(value))) {
      removed.delete(key(value));
      if (!source.has(key(value))) added.set(key(value), value);
    }
  return added.size || removed.size
    ? { added: [...added.values()], removed: [...removed.values()] }
    : undefined;
}

/** Record matcher edits without depending on import/preset/module initialization. */
export function editSourceConditions(
  rule: TableRule,
  conditions: TableRule['conditions'],
): TableRule {
  if (!rule.source) return { ...rule, conditions };
  const edits: RuleEdits = structuredClone(rule.source.edits);
  for (const key of ['domain', 'ip'] as const) {
    if (conditions[key] === rule.conditions[key]) continue;
    const change = listEdit(
      edits[key],
      sourceEntries(rule.conditions[key] ?? '', key),
      sourceEntries(conditions[key] ?? '', key),
      sourceEntries(rule.source.base.conditions[key] ?? '', key),
      key,
    );
    if (change) edits[key] = change;
    else delete edits[key];
  }
  for (const key of new Set([...Object.keys(rule.conditions), ...Object.keys(conditions)])) {
    if (['domain', 'ip', 'process'].includes(key)) continue;
    if (rule.conditions[key] !== conditions[key])
      edits.conditions = { ...edits.conditions, [key]: conditions[key] ?? null };
  }
  return { ...rule, conditions, source: { ...rule.source, edits } };
}

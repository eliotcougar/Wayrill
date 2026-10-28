import {
  sourceEntryKey as entryKey,
  sourceEntries as entries,
  editSourceConditions,
} from './ruleSourceEdits';
import { nativeProcessSelectors, type ApplicationSelector } from './applications';
import {
  routingListEntries,
  ruleTableProblems,
  tableSettings,
  type TableRule,
  type RuleTable,
} from './rules';
import { importTrafficRules, type ImportedTrafficRules } from './trafficRuleImport';
import { bindOutputs, type PresetBindings, type PresetMode } from './routingPresets';
import type { RuleEdits, SourceRule, SourceRow, TrafficSource } from './ruleSourceModel';
import type { RuleNodeData } from './types';
import { LIMITS, CONFIG_LIMIT_LABEL } from '../limits';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unique = <T>(rows: T[], key: (row: T) => string) => [
  ...new Map(rows.map((row) => [key(row), row])).values(),
];
export const applicationIdentity = (row: ApplicationSelector) =>
  JSON.stringify([
    row.kind,
    row.mode,
    row.children,
    row.value
      .trim()
      .replaceAll('\\', '/')
      .replace(row.mode === 'folder' ? /\/+$/ : /$^/, '')
      .toLowerCase(),
  ]);
export function ruleApplications(rule: Pick<SourceRule, 'conditions' | 'applications'>) {
  const rows = new Map<string, ApplicationSelector>();
  for (const row of [
    ...(rule.applications ?? []),
    ...nativeProcessSelectors(routingListEntries(rule.conditions.process ?? '', 'process')),
  ]) {
    const key = applicationIdentity(row);
    if (!rows.get(key)?.enabled) rows.set(key, row);
  }
  return [...rows.values()];
}
export function deduplicateRule(rule: TableRule): TableRule {
  const conditions = { ...rule.conditions };
  for (const key of ['domain', 'ip'])
    if (conditions[key] !== undefined) conditions[key] = entries(conditions[key], key).join('\n');
  if (rule.source) delete conditions.process;
  return {
    ...rule,
    conditions,
    ...(rule.applications || rule.source ? { applications: ruleApplications(rule) } : {}),
  };
}
function plain(rule: SourceRule): SourceRule {
  const conditions = { ...rule.conditions };
  for (const key of ['domain', 'ip'])
    if (conditions[key] !== undefined) conditions[key] = entries(conditions[key], key).join('\n');
  delete conditions.process;
  return {
    name: rule.name,
    enabled: rule.enabled,
    output: rule.output,
    matchAll: rule.matchAll,
    conditions,
    applications: ruleApplications(rule),
    ...(rule.targetMatch ? { targetMatch: rule.targetMatch } : {}),
    ...(rule.native ? { native: structuredClone(rule.native) } : {}),
  };
}
export function editSourcedRule(rule: TableRule, update: Partial<TableRule>): TableRule {
  const next = { ...rule, ...update };
  if (!rule.source) return next;
  const source = rule.source,
    edits: RuleEdits = update.conditions
      ? editSourceConditions(rule, update.conditions).source!.edits
      : structuredClone(source.edits);
  if (
    update.applications ||
    (update.conditions && update.conditions.process !== rule.conditions.process)
  ) {
    const before = ruleApplications(rule),
      after = ruleApplications(next),
      base = ruleApplications(source.base),
      added = new Map((edits.applications?.added ?? []).map((v) => [applicationIdentity(v), v])),
      removed = new Set(edits.applications?.removed),
      old = new Map(before.map((v) => [applicationIdentity(v), v])),
      current = new Map(after.map((v) => [applicationIdentity(v), v])),
      original = new Map(base.map((v) => [applicationIdentity(v), v]));
    for (const key of old.keys())
      if (!current.has(key)) {
        added.delete(key);
        if (original.has(key)) removed.add(key);
      }
    for (const [key, row] of current)
      if (!same(old.get(key), row)) {
        removed.delete(key);
        if (!same(original.get(key), row)) added.set(key, row);
        else added.delete(key);
      }
    if (added.size || removed.size)
      edits.applications = { added: [...added.values()], removed: [...removed] };
    else delete edits.applications;
    next.applications = after;
    next.conditions = { ...next.conditions };
    delete next.conditions.process;
  }
  for (const key of ['name', 'enabled', 'output', 'matchAll', 'targetMatch'] as const)
    if (Object.hasOwn(update, key) && !same(rule[key], next[key]))
      edits.fields = {
        ...edits.fields,
        [key]: key === 'targetMatch' ? (next[key] ?? 'any') : next[key],
      };
  return { ...next, source: { ...source, edits } };
}
export const hasLocalRuleEdits = (rule: TableRule) =>
  !!rule.source && Object.keys(rule.source.edits).length > 0;
function materialize(base: SourceRule, source: SourceRow, id: string): TableRule {
  const rule: TableRule = {
    ...structuredClone(base),
    ...source.edits.fields,
    id,
    conditions: { ...base.conditions },
    source: { ...source, base, missing: false },
  };
  for (const [key, value] of Object.entries(source.edits.conditions ?? {})) {
    if (value === null) delete rule.conditions[key];
    else rule.conditions[key] = value;
  }
  for (const key of ['domain', 'ip'] as const) {
    const edit = source.edits[key];
    if (!edit) continue;
    const removed = new Set(edit.removed.map((v) => entryKey(v, key)));
    rule.conditions[key] = unique(
      [...entries(base.conditions[key] ?? '', key), ...edit.added],
      (v) => entryKey(v, key),
    )
      .filter((v) => !removed.has(entryKey(v, key)))
      .join('\n');
  }
  const apps = source.edits.applications;
  if (apps) {
    const rows = new Map(ruleApplications(base).map((v) => [applicationIdentity(v), v]));
    for (const key of apps.removed) rows.delete(key);
    for (const row of apps.added) rows.set(applicationIdentity(row), row);
    rule.applications = [...rows.values()];
  }
  const targets = (value: SourceRule) => [
    ...['domain', 'ip'].map(
      (key) => routingListEntries(value.conditions[key] ?? '', key).length > 0,
    ),
    ruleApplications(value).some((row) => row.enabled),
  ];
  const before = targets(base),
    after = targets(rule);
  // Empty alternatives can disappear; an emptied AND term or the last target must not broaden the rule.
  if (
    before.some(Boolean) &&
    (!after.some(Boolean) ||
      ((rule.targetMatch ?? 'any') === 'all' && before.some((present, i) => present && !after[i])))
  )
    rule.enabled = false;
  return deduplicateRule(rule);
}
function body(rule: SourceRule, role: string, structural = false): string {
  const conditions = Object.fromEntries(
    Object.entries(rule.conditions)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([key]) => !structural || !['domain', 'ip', 'process'].includes(key)),
  );
  return JSON.stringify([
    role,
    rule.targetMatch ?? 'any',
    rule.matchAll,
    conditions,
    structural
      ? ['domain', 'ip', 'applications'].filter((key) =>
          key === 'applications'
            ? ruleApplications(rule).length
            : routingListEntries(rule.conditions[key] ?? '', key).length,
        )
      : ruleApplications(rule),
  ]);
}
function tokens(rule: SourceRule) {
  return new Set(
    ['domain', 'ip']
      .flatMap((key) =>
        entries(rule.conditions[key] ?? '', key).map((v) => `${key}:${entryKey(v, key)}`),
      )
      .concat(ruleApplications(rule).map(applicationIdentity)),
  );
}
/** Identity first, then unambiguous content/name/shape. Never match legacy rows by position. */
function matchRows(old: TableRule[], incoming: ImportedTrafficRules['rules']) {
  // Normalize each row once. Large legacy lists must not be rebuilt for every pair or token.
  const describe = (rule: SourceRule, role: string) => ({
    exact: body(rule, role),
    shape: body(rule, role, true),
    tokens: tokens(rule),
  });
  const previous = new Map(old.map((row) => [row, describe(row.source!.base, row.source!.role)]));
  const nextRows = new Map(incoming.map((row) => [row, describe(plain(row), row.output)]));
  const result = new Map<number, TableRule>(),
    used = new Set<string>();
  const matchUnique = (
    predicate: (old: TableRule, next: ImportedTrafficRules['rules'][number]) => boolean,
  ) => {
    for (const [i, next] of incoming.entries()) {
      if (result.has(i)) continue;
      const choices = old.filter((row) => !used.has(row.id) && predicate(row, next));
      if (choices.length !== 1) continue;
      const chosen = choices[0];
      if (incoming.some((other, j) => j !== i && !result.has(j) && predicate(chosen, other)))
        continue;
      result.set(i, chosen);
      used.add(chosen.id);
    }
  };
  matchUnique((old, next) => !!next.sourceId && old.source?.identity === next.sourceId);
  const legacy = (old: TableRule, next: ImportedTrafficRules['rules'][number]) =>
    !old.source!.identity || !next.sourceId;
  matchUnique(
    (old, next) => legacy(old, next) && previous.get(old)!.exact === nextRows.get(next)!.exact,
  );
  matchUnique(
    (old, next) =>
      legacy(old, next) &&
      old.source!.role === next.output &&
      old.source!.named &&
      !!next.sourceName &&
      old.source!.base.name === next.name,
  );
  matchUnique((old, next) => {
    const before = previous.get(old)!,
      after = nextRows.get(next)!;
    if (!legacy(old, next) || before.shape !== after.shape) return false;
    for (const token of before.tokens) if (after.tokens.has(token)) return true;
    return false;
  });
  matchUnique(
    (old, next) => legacy(old, next) && previous.get(old)!.shape === nextRows.get(next)!.shape,
  );
  return result;
}
function validate(table: RuleTable) {
  if (
    table.rules.length > 128 ||
    table.outputs.length > 128 ||
    new TextEncoder().encode(JSON.stringify(tableSettings(table))).length > LIMITS.configBytes
  )
    throw new Error(
      `A traffic filter supports 128 rules and outputs within ${CONFIG_LIMIT_LABEL}.`,
    );
  const errors = ruleTableProblems({
    kind: 'routing-filter',
    settings: tableSettings(table),
  } as RuleNodeData).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new Error(errors[0].message);
  return table;
}
export function attachTrafficSource(
  table: RuleTable,
  parsed: ImportedTrafficRules,
  bindings: PresetBindings,
  mode: PresetMode,
  location: Omit<TrafficSource, 'version' | 'bindings' | 'updatedAt'>,
): RuleTable {
  checkIdentities(parsed);
  const imported = importTrafficRules(table, parsed, bindings, mode),
    start = mode === 'append' ? table.rules.length : 0;
  const mapped: Record<string, string> = {};
  const rules = imported.rules.map((row, index) => {
    if (index < start) return { ...row, source: undefined };
    const input = parsed.rules[index - start],
      base = plain(row);
    mapped[input.output] = row.output;
    return {
      ...base,
      id: row.id,
      source: {
        identity: input.sourceId,
        named: !!input.sourceName,
        role: input.output,
        base: structuredClone(base),
        edits: {},
      },
    };
  });
  if (parsed.defaultOutput && mode === 'replace')
    mapped[parsed.defaultOutput] = imported.defaultOutput;
  return validate({
    ...imported,
    rules,
    source: { ...location, version: 1, bindings: mapped, updatedAt: new Date().toISOString() },
  });
}
export function refreshTrafficSource(
  table: RuleTable,
  parsed: ImportedTrafficRules,
  bindings: PresetBindings = {},
): RuleTable {
  if (!table.source) throw new Error('Choose a filter source first.');
  checkIdentities(parsed);
  const resolved = { ...table.source.bindings, ...bindings };
  const roles = parsed.roles.filter((r) => parsed.rules.some((row) => row.output === r.id));
  for (const role of roles)
    if (!table.outputs.some((o) => o.id === resolved[role.id]) && !Object.hasOwn(bindings, role.id))
      throw new Error(`Choose an output for “${role.name}”.`);
  const { outputs, ids: outputIds } = bindOutputs(table.outputs, roles, resolved, (id, name) => ({
    id,
    name,
  }));
  const mapped = {
    outputs,
    rules: parsed.rules.map((row) => ({
      ...plain(row),
      id: crypto.randomUUID(),
      output: outputIds[row.output],
    })),
  };
  const matches = matchRows(
      table.rules.filter((r) => !!r.source),
      parsed.rules,
    ),
    kept = new Set<string>(),
    refreshed = mapped.rules.map((row, i) => {
      const input = parsed.rules[i],
        previous = matches.get(i),
        base = plain(row);
      resolved[input.output] = row.output;
      if (previous) {
        if (
          hasLocalRuleEdits(previous) &&
          (previous.source!.base.targetMatch ?? 'any') !== (base.targetMatch ?? 'any')
        )
          throw new Error(
            `“${previous.name}” changed matching logic. Keep the current rules or detach the source before replacing them.`,
          );
        kept.add(previous.id);
      }
      return materialize(
        base,
        {
          identity: input.sourceId,
          named: !!input.sourceName,
          role: input.output,
          base,
          edits: previous?.source?.edits ?? {},
        },
        previous?.id ?? row.id,
      );
    });
  const gaps = new Map<string | null, TableRule[]>();
  let anchor: string | null = null;
  for (const row of table.rules) {
    if (kept.has(row.id)) {
      anchor = row.id;
      continue;
    }
    if (!row.source || hasLocalRuleEdits(row)) {
      const group = gaps.get(anchor) ?? [];
      group.push(row.source ? { ...row, source: { ...row.source, missing: true } } : row);
      gaps.set(anchor, group);
    }
  }
  const rules = [
    ...(gaps.get(null) ?? []),
    ...refreshed.flatMap((r) => [r, ...(gaps.get(r.id) ?? [])]),
  ];
  const rolesInUse = new Set(rules.flatMap((rule) => (rule.source ? [rule.source.role] : [])));
  return validate({
    ...table,
    outputs: mapped.outputs,
    rules,
    source: {
      ...table.source,
      bindings: Object.fromEntries(
        Object.entries(resolved).filter(([role]) => rolesInUse.has(role)),
      ),
      updatedAt: new Date().toISOString(),
    },
  });
}
function checkIdentities(parsed: ImportedTrafficRules) {
  const ids = parsed.rules.map((r) => r.sourceId).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('The source contains duplicate rule IDs.');
}
export function detachTrafficSource(table: RuleTable): RuleTable {
  return {
    ...table,
    source: undefined,
    rules: table.rules.map(({ source: _row, ...rule }) => rule),
  };
}
export { remapTrafficSource } from './ruleSourceRemap';

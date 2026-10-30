import { LIMITS, CONFIG_LIMIT_LABEL } from '../limits';
import { portableDnsRule } from '../portableJson';
import { parseXrayJson, jsonRecord, jsonArray } from './xrayJson';
import {
  readDnsFilter,
  dnsFilterSettings,
  dnsProblems,
  type DnsFilter,
  type DnsRoute,
} from './dns';
import { dnsSourceLists, type DnsSourceRule, type DnsSourceRow } from './dnsRuleSourceModel';
import type { RuleSource } from './ruleSourceModel';
import { sourceEntries, sourceEntryKey } from './ruleSourceEdits';
import { matchSourceRows, preserveLocalRows } from './ruleSourceMerge';
import { bindOutputs, type PresetBindings, type PresetMode } from './routingPresets';
import type { RuleNodeData } from './types';

export const dnsRulesFormat = 'wayrill.dns-rules';
const listKind = (key: string) => (key === 'domains' ? 'domain' : 'ip');
const plain = ({ id: _id, source: _source, ...rule }: DnsRoute): DnsSourceRule => ({
  ...rule,
  ...Object.fromEntries(
    dnsSourceLists.map((key) => [key, sourceEntries(rule[key], listKind(key)).join('\n')]),
  ),
});
function validate(filter: DnsFilter) {
  if (
    new TextEncoder().encode(JSON.stringify(dnsFilterSettings(filter))).length > LIMITS.configBytes
  )
    throw new Error(`DNS rules must fit within ${CONFIG_LIMIT_LABEL}.`);
  readDnsFilter(dnsFilterSettings(filter));
  const error = dnsProblems({
    kind: 'dns-routing-filter',
    settings: dnsFilterSettings(filter),
  } as RuleNodeData).find((issue) => issue.severity === 'error');
  if (error) throw new Error(error.message);
  return filter;
}
export function parseDnsRules(text: string): DnsFilter {
  if (new TextEncoder().encode(text).length > LIMITS.configBytes)
    throw new Error(`DNS rules must fit within ${CONFIG_LIMIT_LABEL}.`);
  const value = parseXrayJson(text);
  if (
    !jsonRecord(value) ||
    value.format !== dnsRulesFormat ||
    value.version !== 1 ||
    !jsonArray(value.rules)
  )
    throw new Error('Use a Wayrill DNS rules export (wayrill.dns-rules, version 1).');
  return validate(
    readDnsFilter({
      outputs: JSON.stringify(value.outputs),
      rules: JSON.stringify(value.rules.map((rule) => portableDnsRule(rule, 'read'))),
      fallbackMode: String(value.fallbackMode),
      parallel: value.parallel as boolean,
      ...(value.fallbackFirst === undefined
        ? {}
        : { fallbackFirst: value.fallbackFirst as boolean }),
      ...(value.source === undefined ? {} : { ruleSource: JSON.stringify(value.source) }),
    }),
  );
}
export function exportDnsRules(filter: DnsFilter, name: string, embedOverrides = false): string {
  validate(filter);
  const { source, ...data } = filter;
  return (
    JSON.stringify(
      {
        format: dnsRulesFormat,
        version: 1,
        name,
        ...data,
        rules: filter.rules.map(({ source, ...rule }) =>
          portableDnsRule({ ...rule, ...(!embedOverrides && source ? { source } : {}) }, 'write'),
        ),
        ...(!embedOverrides && source ? { source } : {}),
      },
      null,
      2,
    ) + '\n'
  );
}
export { editSourcedDnsRule } from './dnsRuleSourceEdits';
export function remapDnsSource(filter: DnsFilter, ids: ReadonlyMap<string, string>): DnsFilter {
  const remap = (id: string) => ids.get(id) ?? id;
  return {
    ...filter,
    ...(filter.source
      ? {
          source: {
            ...filter.source,
            bindings: Object.fromEntries(
              Object.entries(filter.source.bindings).map(([role, id]) => [role, remap(id)]),
            ),
          },
        }
      : {}),
    rules: filter.rules.map((rule) => ({
      ...rule,
      output: remap(rule.output),
      ...(rule.source
        ? {
            source: {
              ...rule.source,
              base: { ...rule.source.base, output: remap(rule.source.base.output) },
              edits: {
                ...rule.source.edits,
                ...(rule.source.edits.fields
                  ? {
                      fields: {
                        ...rule.source.edits.fields,
                        ...(rule.source.edits.fields.output
                          ? { output: remap(rule.source.edits.fields.output) }
                          : {}),
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
    })),
  };
}
export function detachDnsSource(filter: DnsFilter): DnsFilter {
  return {
    ...filter,
    source: undefined,
    rules: filter.rules.map(({ source: _source, ...rule }) => rule),
  };
}
function mappedDnsRules(filter: DnsFilter, incoming: DnsFilter, bindings: PresetBindings) {
  const fallback = filter.outputs.find((output) => output.fallback)!;
  const { outputs, ids } = bindOutputs(
    filter.outputs,
    incoming.outputs.filter((output) => !output.fallback),
    bindings,
    (id, name) => ({ id, name, fallback: false }),
  );
  ids[incoming.outputs.find((output) => output.fallback)!.id] = fallback.id;
  const mapped = remapDnsSource(incoming, new Map(Object.entries(ids)));
  return { ...mapped, outputs, bindings: ids };
}
export function importDnsRules(
  filter: DnsFilter,
  incoming: DnsFilter,
  bindings: PresetBindings,
  mode: PresetMode,
  location?: Omit<RuleSource, 'version' | 'bindings' | 'updatedAt'>,
): DnsFilter {
  const mapped = mappedDnsRules(filter, incoming, bindings);
  const rules = mapped.rules.map((row, index) => {
    const id = crypto.randomUUID();
    if (!location) return mode === 'append' ? { ...plain(row), id } : { ...row, id };
    const base = plain(row);
    return {
      ...base,
      id,
      source: {
        identity: incoming.rules[index].id,
        role: incoming.rules[index].output,
        base,
        edits: {},
      },
    };
  });
  return validate({
    ...filter,
    outputs: mapped.outputs,
    rules:
      mode === 'append'
        ? [...(location ? detachDnsSource(filter) : filter).rules, ...rules]
        : rules,
    ...(mode === 'replace'
      ? {
          fallbackMode: incoming.fallbackMode,
          parallel: incoming.parallel,
          fallbackFirst: incoming.fallbackFirst,
        }
      : {}),
    source: location
      ? { ...location, version: 1, bindings: mapped.bindings, updatedAt: new Date().toISOString() }
      : mode === 'replace'
        ? mapped.source
        : filter.source,
  });
}
function materialize(base: DnsSourceRule, source: DnsSourceRow, id: string): DnsRoute {
  const rule = { ...base, ...source.edits.fields, id, source: { ...source, base, missing: false } };
  for (const key of dnsSourceLists) {
    const edit = source.edits.lists?.[key],
      kind = listKind(key);
    if (!edit) continue;
    const removed = new Set(edit.removed.map((value) => sourceEntryKey(value, kind)));
    rule[key] = sourceEntries([...sourceEntries(base[key], kind), ...edit.added].join('\n'), kind)
      .filter((value) => !removed.has(sourceEntryKey(value, kind)))
      .join('\n');
    // A removed domain/IP constraint must never turn into an unrestricted resolver preference.
    if (sourceEntries(base[key], kind).length && !sourceEntries(rule[key], kind).length)
      rule.enabled = false;
  }
  return rule;
}
export function refreshDnsSource(
  filter: DnsFilter,
  incoming: DnsFilter,
  bindings: PresetBindings,
): DnsFilter {
  if (!filter.source) throw new Error('Choose a DNS filter source first.');
  const mapped = mappedDnsRules(filter, detachDnsSource(incoming), {
    ...filter.source.bindings,
    ...bindings,
  });
  const old = filter.rules.filter((rule) => rule.source);
  const describe = (base: DnsSourceRule, role: string, identity: string) => ({
    identity,
    role,
    name: base.name,
    exact: JSON.stringify([role, base]),
    shape: JSON.stringify([
      role,
      base.skipFallback,
      base.finalQuery,
      dnsSourceLists.filter((key) => sourceEntries(base[key], listKind(key)).length),
    ]),
    tokens: new Set(
      dnsSourceLists.flatMap((key) =>
        sourceEntries(base[key], listKind(key)).map(
          (value) => `${key}:${sourceEntryKey(value, listKind(key))}`,
        ),
      ),
    ),
  });
  const matches = matchSourceRows(
    old.map((rule) => describe(rule.source!.base, rule.source!.role, rule.source!.identity)),
    incoming.rules.map((rule) => describe(plain(rule), rule.output, rule.id)),
  );
  const refreshed = mapped.rules.map((row, i) => {
    const match = matches.get(i),
      previous = match === undefined ? undefined : old[match],
      base = plain(row);
    return materialize(
      base,
      {
        identity: incoming.rules[i].id,
        role: incoming.rules[i].output,
        base,
        edits: previous?.source?.edits ?? {},
      },
      previous?.id ?? row.id,
    );
  });
  const rules = preserveLocalRows(filter.rules, refreshed, (row) =>
    !row.source
      ? row
      : Object.keys(row.source.edits).length
        ? { ...row, source: { ...row.source, missing: true } }
        : undefined,
  );
  const roles = new Set([
    ...incoming.outputs.map((output) => output.id),
    ...rules.flatMap((rule) => (rule.source ? [rule.source.role] : [])),
  ]);
  const resolved = { ...filter.source.bindings, ...mapped.bindings };
  return validate({
    ...filter,
    outputs: mapped.outputs,
    rules,
    source: {
      ...filter.source,
      bindings: Object.fromEntries(Object.entries(resolved).filter(([role]) => roles.has(role))),
      updatedAt: new Date().toISOString(),
    },
  });
}

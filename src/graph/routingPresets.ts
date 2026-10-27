import catalog from './routingPresets.json';
import type { NamedOutput, RuleTable, TableRule } from './rules';
import type { DnsFilter, DnsRoute } from './dns';

export const trafficPresets = catalog.traffic;
export const dnsPresets = catalog.dns;
export type TrafficPreset = (typeof trafficPresets)[number];
export type DnsPreset = (typeof dnsPresets)[number];
export type PresetBindings = Record<string, string>;
export type PresetMode = 'replace' | 'append';
export const newPresetOutput = '__new_output__';
export const trafficRoles = [
  { id: 'proxy', name: 'Proxy' },
  { id: 'direct', name: 'Direct' },
  { id: 'block', name: 'Block' },
];
export function rolesForTraffic(preset: TrafficPreset) {
  return trafficRoles.filter(
    (role) => role.id === preset.defaultOutput || preset.rules.some((r) => r.output === role.id),
  );
}
export function bindOutputs<O extends NamedOutput>(
  outputs: O[],
  roles: { id: string; name: string }[],
  bindings: PresetBindings,
  make: (id: string, name: string) => O,
) {
  const next = [...outputs],
    ids: PresetBindings = {};
  for (const role of roles) {
    const bound = bindings[role.id];
    if (bound === newPresetOutput) {
      let name = role.name,
        suffix = 2;
      while (next.some((o) => o.name.trim().toLowerCase() === name.toLowerCase()))
        name = `${role.name} ${suffix++}`;
      const id = crypto.randomUUID();
      next.push(make(id, name));
      ids[role.id] = id;
    } else {
      if (!next.some((o) => o.id === bound)) throw new Error(`Choose an output for ${role.name}.`);
      ids[role.id] = bound;
    }
  }
  return { outputs: next, ids };
}
export function importTrafficPreset(
  table: RuleTable,
  preset: TrafficPreset,
  bindings: PresetBindings,
  mode: PresetMode,
): RuleTable {
  const { outputs, ids } = bindOutputs(
    table.outputs,
    rolesForTraffic(preset),
    bindings,
    (id, name) => ({ id, name }),
  );
  const rows: TableRule[] = preset.rules.map((r) => ({
    id: crypto.randomUUID(),
    name: r.name,
    enabled: true,
    matchAll: false,
    output: ids[r.output],
    conditions: Object.fromEntries(
      Object.entries(r.conditions).filter(([, value]) => typeof value === 'string'),
    ),
    targetMatch: 'any',
  }));
  const rules = mode === 'append' ? [...table.rules, ...rows] : rows;
  if (outputs.length > 128 || rules.length > 128)
    throw new Error('A traffic filter supports 128 outputs and 128 rules.');
  return {
    ...table,
    ...(mode === 'replace' ? { source: undefined } : {}),
    outputs,
    rules,
    defaultOutput: mode === 'append' ? table.defaultOutput : ids[preset.defaultOutput],
  };
}
export function importDnsPreset(
  filter: DnsFilter,
  preset: DnsPreset,
  bindings: PresetBindings,
  mode: PresetMode,
): DnsFilter {
  const fallback = filter.outputs.find((o) => o.fallback);
  if (!fallback) throw new Error('The DNS filter needs its Fallback output.');
  const { outputs, ids } = bindOutputs(
    filter.outputs,
    preset.roles.filter((r) => r.id !== 'fallback'),
    bindings,
    (id, name) => ({ id, name, fallback: false }),
  );
  ids.fallback = fallback.id;
  const rows: DnsRoute[] = preset.rules.map((r) => ({
    id: crypto.randomUUID(),
    enabled: true,
    output: ids[r.output],
    unexpectedIPs: '',
    finalQuery: false,
    name: r.name,
    domains: r.domains,
    expectedIPs: r.expectedIPs,
    skipFallback: r.skipFallback,
  }));
  const rules = mode === 'append' ? [...filter.rules, ...rows] : rows;
  if (outputs.length > 16 || rules.length > 128)
    throw new Error('A DNS filter supports 16 outputs and 128 preferences.');
  return {
    ...filter,
    outputs,
    rules,
    ...(mode === 'replace'
      ? { fallbackMode: 'always', parallel: false, fallbackFirst: preset.fallbackFirst }
      : {}),
  };
}

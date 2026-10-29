import { describe, expect, it } from 'vitest';
import { parseTrafficRules } from './trafficRuleImport';
import {
  readRuleTable,
  tableSettings,
  routingRuleVariants,
  type RuleTable,
  type TableRule,
} from './rules';
import {
  attachTrafficSource,
  refreshTrafficSource,
  editSourcedRule,
  detachTrafficSource,
  remapTrafficSource,
} from './trafficRuleSource';
import type { ApplicationSelector } from './applications';

const outputs = [
  { id: 'proxy', name: 'Proxy' },
  { id: 'direct', name: 'Direct' },
  { id: 'block', name: 'Block' },
];
const table: RuleTable = {
  outputs,
  rules: [],
  defaultOutput: 'direct',
  tunAmbiguity: { action: 'allow', output: 'proxy' },
};
const bindings = {
  'outbound:proxy': 'proxy',
  'outbound:direct': 'direct',
  'outbound:block': 'block',
};
const location = {
  kind: 'url' as const,
  location: 'https://example.net/rules.json',
  allowHttp: false,
  viaWayrill: false,
};
const parse = (rules: unknown) => parseTrafficRules(JSON.stringify(rules));
const row = (id: string, domain = ['domain:source.example']) => ({
  id,
  remarks: id,
  domain,
  outboundTag: 'proxy',
});
const attach = (rules: unknown, base = table) =>
  attachTrafficSource(base, parse(rules), bindings, 'replace', location);
const update = (current: RuleTable, rules: unknown) => refreshTrafficSource(current, parse(rules));
const edit = (current: RuleTable, index: number, changes: Partial<TableRule>): RuleTable => ({
  ...current,
  rules: current.rules.map((r, i) => (i === index ? editSourcedRule(r, changes) : r)),
});
const app = (value: string, children = false): ApplicationSelector => ({
  value,
  children,
  enabled: true,
  kind: 'process',
  mode: 'name',
});

describe('manual traffic source updates', () => {
  it('keeps local domain, IP and process entries across repeated updates and adoption by the source', () => {
    const original = [{ ...row('web'), ip: ['192.0.2.1'], process: ['source.exe'] }];
    let current = attach(original);
    current = edit(current, 0, {
      conditions: {
        domain: 'domain:source.example\ndomain:local.example\ndomain:local.example',
        ip: '192.0.2.1\n198.51.100.9',
      },
      applications: [...current.rules[0].applications!, app('local.exe', true)],
    });
    const originalId = current.rules[0].id;
    const saved = readRuleTable(tableSettings(current));
    current = update(saved, [
      {
        ...row('web', ['domain:new.example', 'domain:local.example']),
        ip: ['198.51.100.9'],
        blocks: undefined,
        process: ['source.exe'],
      },
    ]);
    current = update(readRuleTable(tableSettings(current)), [
      { ...row('web', ['domain:last.example']), ip: ['203.0.113.4'], process: ['new.exe'] },
    ]);
    expect(current.rules[0].id).toBe(originalId);
    expect(current.rules[0].conditions).toEqual({
      domain: 'domain:last.example\ndomain:local.example',
      ip: '203.0.113.4\n198.51.100.9',
    });
    expect(current.rules[0].applications).toEqual([app('new.exe'), app('local.exe', true)]);
    expect(current.defaultOutput).toBe('direct');
    expect(current.outputs).toEqual(outputs);
    expect(current.tunAmbiguity).toEqual(table.tunAmbiguity);
  });
  it('retains new local rules and their priority gaps while source rows are reordered and renamed', () => {
    let current = attach([row('one'), row('two', ['two.example'])]);
    const [first, second] = current.rules;
    const local = {
      ...first,
      source: undefined,
      id: 'local',
      name: 'Local',
      conditions: { domain: 'local.example' },
    };
    current = { ...current, rules: [{ ...local, id: 'before' }, first, local, second] };
    current = update(current, [
      { ...row('two', ['updated.example']), remarks: 'Renamed' },
      row('one'),
    ]);
    expect(current.rules.map((r) => r.id)).toEqual(['before', second.id, first.id, 'local']);
    expect(current.rules[1].name).toBe('Renamed');
    expect(readRuleTable(tableSettings(current))).toEqual(current);
  });
  it('retains a removed customized rule with all original conditions, and reconnects it when it returns', () => {
    let current = attach([row('one'), row('two')]);
    current = edit(current, 0, {
      conditions: { domain: 'domain:source.example\ndomain:local.example', port: '443' },
      enabled: false,
      name: 'Personal name',
    });
    const id = current.rules[0].id;
    current = update(current, [row('two')]);
    expect(current.rules.find((r) => r.id === id)).toMatchObject({
      name: 'Personal name',
      enabled: false,
      source: { missing: true },
    });
    current = update(readRuleTable(tableSettings(current)), [
      row('one', ['new.example']),
      row('two'),
    ]);
    expect(current.rules.filter((r) => r.id === id)).toHaveLength(1);
    expect(current.rules[0]).toMatchObject({
      enabled: false,
      name: 'Personal name',
      conditions: { domain: 'new.example\ndomain:local.example', port: '443' },
      source: { missing: false },
    });
  });
  it('requires mapping of new output roles and retains local output choices and the current fallback', () => {
    let current = attach([row('one')]);
    current = edit(current, 0, { output: 'block' });
    const source = parse([
      { ...row('one'), outboundTag: 'new' },
      { network: 'tcp,udp', outboundTag: 'proxy' },
    ]);
    expect(() => refreshTrafficSource(current, source)).toThrow('Choose an output');
    const next = refreshTrafficSource(current, source, { 'outbound:new': 'direct' });
    expect(next.rules[0].output).toBe('block');
    expect(next.defaultOutput).toBe('direct');
  });
  it('rejects duplicate source IDs, invalid results and incompatible matching changes atomically', () => {
    const current = edit(attach([row('one')]), 0, {
      conditions: { domain: 'domain:source.example\nlocal.example' },
    });
    const snapshot = structuredClone(current);
    expect(() => update(current, [row('one'), row('one')])).toThrow('duplicate rule IDs');
    expect(() => attach([row('one'), row('one')])).toThrow('duplicate rule IDs');
    expect(() => update(current, { rules: [row('one')] })).toThrow('changed matching logic');
    expect(() => update(current, [{ ...row('one'), port: 'bad' }])).toThrow();
    expect(current).toEqual(snapshot);
  });
  it('does not broaden an emptied selector into a catch-all and persists exclusions if the entry returns', () => {
    let current = edit(attach([row('one')]), 0, { conditions: { domain: '' } });
    current = update(current, [row('one')]);
    expect(current.rules[0].enabled).toBe(false);
    current = update(current, [row('one', ['other.example'])]);
    expect(current.rules[0].enabled).toBe(true);
    current = update(current, [row('one')]);
    expect(current.rules[0].enabled).toBe(false);
  });
  it('detaches sources without changing effective routing, and remaps source bindings on filter restore', () => {
    let current = attach([row('one')]);
    current = edit(current, 0, {
      output: 'block',
      conditions: { domain: 'domain:source.example\nlocal.example' },
    });
    const mapped = remapTrafficSource(
      current,
      new Map([
        ['proxy', 'new-proxy'],
        ['block', 'new-block'],
      ]),
    );
    expect(mapped.source?.bindings['outbound:proxy']).toBe('new-proxy');
    expect(mapped.rules[0].source?.base.output).toBe('new-proxy');
    expect(mapped.rules[0].source?.edits.fields?.output).toBe('new-block');
    const detached = detachTrafficSource(current);
    expect(detached.source).toBeUndefined();
    expect(detached.rules[0].source).toBeUndefined();
    expect(routingRuleVariants(detached.rules[0])).toEqual(routingRuleVariants(current.rules[0]));
    expect(readRuleTable(tableSettings(detached))).toEqual(detached);
  });
});

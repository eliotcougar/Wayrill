import { describe, expect, it } from 'vitest';
import fixture from './fixtures/v2rayN-lab-routing.json';
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
import { createRoutingExample } from './example';
import { enableDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';

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
  it('keeps a re-enabled source application enabled on subsequent refreshes', () => {
    const source = [{ ...row('web'), process: ['browser.exe'] }];
    let current = attach(source);
    const original = current.rules[0].applications![0];
    current = edit(current, 0, { applications: [{ ...original, enabled: false }] });
    current = update(readRuleTable(tableSettings(current)), source);
    expect(current.rules[0].applications).toEqual([{ ...app('browser.exe'), enabled: false }]);
    current = edit(current, 0, { applications: [{ ...original, enabled: true }] });
    expect(current.rules[0].applications).toEqual([app('browser.exe')]);
    for (let i = 0; i < 2; i++) {
      current = update(readRuleTable(tableSettings(current)), [
        { ...row('web', [`domain:updated${i}.test`]), process: ['browser.exe', 'new.exe'] },
      ]);
      expect(current.rules[0].applications).toEqual([app('browser.exe'), app('new.exe')]);
    }
  });
  it('compiles source-backed rules exactly like the same effective local rules', () => {
    const graph = enableDefaults(createRoutingExample());
    const filter = graph.nodes.find((n) => n.data.kind === 'routing-filter')!;
    let source = attachTrafficSource(
      readRuleTable(filter.data.settings),
      parse([row('web')]),
      { 'outbound:proxy': 'preferred' },
      'replace',
      location,
    );
    source = edit(source, 0, {
      conditions: { domain: 'domain:source.example\nfull:local.example' },
    });
    source = update(source, [row('web', ['domain:new.example'])]);
    const compile = (table: RuleTable) =>
      compileRuntimeGraph({
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === filter.id
            ? {
                ...n,
                data: { ...n.data, settings: { ...n.data.settings, ...tableSettings(table) } },
              }
            : n,
        ),
      });
    const linked = compile(source),
      local = compile(detachTrafficSource(source));
    expect(linked.config).toEqual(local.config);
    expect(linked.capture).toEqual(local.capture);
    expect(JSON.stringify(linked.config)).not.toContain(location.location);
    expect(JSON.stringify(linked.config)).toContain('full:local.example');
  });
  it('refreshes full-size anonymous rule sets whose lists change completely', () => {
    const source = (prefix: string) =>
      Array.from({ length: 128 }, (_, i) => ({
        domain: Array.from({ length: 256 }, (_, j) => `domain:${prefix}-${i}-${j}.example`),
        outboundTag: 'proxy',
      }));
    const current = attach(source('old'));
    const next = update(current, source('new'));
    expect(next.rules).toHaveLength(128);
    expect(next.rules[0].conditions.domain.split('\n')[0]).toBe('domain:new-0-0.example');
    expect(next.rules[127].conditions.domain.split('\n').at(-1)).toBe('domain:new-127-255.example');
    expect(next.outputs).toEqual(current.outputs);
  });
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
  it('deduplicates only within a rule, respecting process modes and child tracking', () => {
    const current = attach([
      {
        ...row('one', ['full:Example.NET', 'full:example.net', 'regexp:^A', 'regexp:^a']),
        ip: ['192.0.2.1', '192.0.2.1'],
        process: ['C:\\Apps\\A.exe', 'c:/apps/a.exe', 'a.exe'],
      },
      row('two', ['full:example.net']),
    ]);
    expect(current.rules[0].conditions).toEqual({
      domain: 'full:example.net\nregexp:^A\nregexp:^a',
      ip: '192.0.2.1',
    });
    expect(current.rules[0].applications).toHaveLength(2);
    expect(current.rules[1].conditions.domain).toBe('full:example.net');
    const modified = edit(current, 0, {
      applications: [...current.rules[0].applications!, app('a.exe', true)],
    });
    expect(update(modified, [row('one'), row('two')]).rules[0].applications).toContainEqual(
      app('a.exe', true),
    );
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
  it('matches anonymous lab rows using unchanged/overlapping contents, and never discards ambiguous local additions', () => {
    let current = attach(fixture);
    const index = current.rules.findIndex((r) => !!r.conditions.domain);
    const originalId = current.rules[index].id;
    current = edit(current, index, {
      conditions: {
        ...current.rules[index].conditions,
        domain: current.rules[index].conditions.domain + '\nlocal.example',
      },
    });
    current = update(current, fixture);
    expect(current.rules.find((r) => r.id === originalId)?.conditions.domain).toContain(
      'local.example',
    );
    let ambiguous = attach([
      { domain: ['a.example'], outboundTag: 'proxy' },
      { domain: ['b.example'], outboundTag: 'proxy' },
    ]);
    ambiguous = edit(ambiguous, 0, { conditions: { domain: 'a.example\nlocal.example' } });
    const refreshed = update(ambiguous, [
      { domain: ['c.example'], outboundTag: 'proxy' },
      { domain: ['d.example'], outboundTag: 'proxy' },
    ]);
    expect(refreshed.rules).toHaveLength(3);
    expect(refreshed.rules[0]).toMatchObject({
      conditions: { domain: 'a.example\nlocal.example' },
      source: { missing: true },
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
  it('removes empty OR alternatives while retaining other selectors, but never weakens an AND term', () => {
    const source = [{ ...row('one'), ip: ['192.0.2.1'], port: '443' }];
    let current = edit(attach(source), 0, {
      conditions: { domain: '', ip: '192.0.2.1', port: '443' },
    });
    current = update(current, source);
    expect(current.rules[0].enabled).toBe(true);
    expect(routingRuleVariants(current.rules[0])).toEqual([{ ip: ['192.0.2.1'], port: '443' }]);
    current = edit(current, 0, { conditions: { domain: '', ip: '', port: '443' } });
    expect(update(current, source).rules[0].enabled).toBe(false);
    const native = { rules: source };
    let and = attach(native);
    and = edit(and, 0, { conditions: { ...and.rules[0].conditions, domain: '' } });
    expect(update(and, native).rules[0].enabled).toBe(false);
  });
  it('preserves file source paths and rejects malformed stored provenance', () => {
    const current = attachTrafficSource(table, parse([row('one')]), bindings, 'replace', {
      ...location,
      kind: 'file',
      location: 'C:\\Правила\\rules.json',
    });
    expect(readRuleTable(tableSettings(current))).toEqual(current);
    const corrupted = structuredClone(current);
    corrupted.rules[0].source!.base.conditions.fake = 'invalid';
    expect(() => readRuleTable(tableSettings(corrupted))).toThrow('Invalid rule condition');
  });
  it('rejects an update exceeding the combined local and source row budget without truncation', () => {
    const current = attach([row('one')]);
    current.rules.push({ ...current.rules[0], id: 'local', source: undefined });
    const before = structuredClone(current);
    expect(() =>
      update(
        current,
        Array.from({ length: 128 }, (_, i) => row(`row-${i}`)),
      ),
    ).toThrow('128 rules');
    expect(current).toEqual(before);
  });
});

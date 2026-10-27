import { expect, it } from 'vitest';
import { compatibleOutput, exportCompatibleRules, exportWayrillRules } from './trafficRuleExport';
import { importTrafficRules, parseTrafficRules, rolesForTrafficImport } from './trafficRuleImport';
import { newPresetOutput } from './routingPresets';
import { captureRuleVariants, type RuleTable, type TableRule } from './rules';
import { attachTrafficSource, editSourcedRule, refreshTrafficSource } from './trafficRuleSource';
import { makeNode } from './catalog';
import { factoryDefaults } from './defaults';

const row = (conditions: Record<string, string>, extra: Partial<TableRule> = {}): TableRule => ({
  id: 'r',
  name: 'Work 🦊',
  enabled: true,
  output: 'proxy',
  matchAll: false,
  conditions,
  ...extra,
});
const table = (...rules: TableRule[]): RuleTable => ({
  outputs: [
    { id: 'proxy', name: 'Through proxy' },
    { id: 'local', name: 'Local' },
  ],
  rules,
  defaultOutput: 'local',
  tunAmbiguity: { action: 'allow', output: 'proxy' },
});
const destinations = { proxy: 'My server', local: 'direct' };
const process = {
  kind: 'process',
  mode: 'name',
  value: 'browser.exe',
  enabled: true,
  children: false,
} as const;

it('round trips all Wayrill rule features, comments, disabled rows and output policies through the import workflow', () => {
  const original = table(
    row(
      { domain: '# Note\ndomain:example.net', attrs: '{":method": "GET"}' },
      {
        targetMatch: 'all',
        enabled: false,
        applications: [
          { ...process, children: true },
          { kind: 'service', mode: 'name', value: 'Dnscache', enabled: true, children: false },
        ],
      },
    ),
  );
  const text = exportWayrillRules(original, 'Home 🌐');
  const file = JSON.parse(text);
  expect(file.rules[0].conditions.domain).toEqual(['# Note', 'domain:example.net']);
  expect(file.rules[0].conditions.attrs).toEqual({ ':method': 'GET' });
  expect(text).toContain('\n  "outputs": [\n    {');
  const source = parseTrafficRules(text);
  const restored = importTrafficRules(
    table(),
    source,
    { proxy: 'proxy', local: 'local' },
    'replace',
  );
  expect(restored.rules).toEqual(
    original.rules.map((r) => ({
      ...r,
      id: expect.any(String),
      conditions: { ...r.conditions, attrs: '{":method":"GET"}' },
    })),
  );
  expect(restored.tunAmbiguity).toEqual(original.tunAmbiguity);
  expect(restored.defaultOutput).toBe('local');
  expect(
    importTrafficRules(table(), source, { proxy: 'proxy', local: 'local' }, 'append').tunAmbiguity,
  ).toEqual(table().tunAmbiguity);
});

it('exports effective local edits without leaking source URLs, baselines or override metadata', () => {
  const imported = parseTrafficRules(
    '[{"id":"source","domain":["domain:a.test"],"outboundTag":"proxy"}]',
  );
  let source = attachTrafficSource(table(), imported, { 'outbound:proxy': 'proxy' }, 'replace', {
    kind: 'url',
    location: 'https://private.test/rules?secret=yes',
    allowHttp: false,
    viaWayrill: false,
  });
  source = {
    ...source,
    rules: source.rules.map((r) =>
      editSourcedRule(r, { conditions: { domain: 'domain:a.test\ndomain:local.test' } }),
    ),
  };
  const text = exportWayrillRules(source, 'Shared', true);
  expect(text).not.toMatch(/private.test|sourceRules|"base"|"edits"|"source"/);
  expect(parseTrafficRules(text).rules[0].conditions.domain).toContain('domain:local.test');
});

it('preserves source and overrides separately, rebinds every reference and can continue updating', () => {
  const parse = (domain: string) =>
    parseTrafficRules(JSON.stringify([{ id: 'provider', domain: [domain], outboundTag: 'proxy' }]));
  let authored = attachTrafficSource(
    table(),
    parse('domain:a.test'),
    { 'outbound:proxy': 'proxy' },
    'replace',
    { kind: 'url', location: 'https://example.test/rules', allowHttp: false, viaWayrill: false },
  );
  authored = {
    ...authored,
    rules: authored.rules.map((r) =>
      editSourcedRule(r, {
        output: 'local',
        conditions: { domain: 'domain:a.test\ndomain:mine.test' },
      }),
    ),
  };
  const file = exportWayrillRules(authored, 'Editable');
  expect(JSON.parse(file).rules[0].source.base.conditions.domain).toEqual(['domain:a.test']);
  expect(JSON.parse(file).rules[0].source.edits.domain.added).toEqual(['domain:mine.test']);
  const source = parseTrafficRules(file);
  const restored = importTrafficRules(
    {
      ...table(),
      outputs: [
        { id: 'new-proxy', name: 'New proxy' },
        { id: 'new-local', name: 'New local' },
      ],
      defaultOutput: 'new-local',
      tunAmbiguity: undefined,
    },
    source,
    { proxy: 'new-proxy', local: 'new-local' },
    'replace',
  );
  expect(restored.source?.bindings['outbound:proxy']).toBe('new-proxy');
  expect(restored.rules[0].source?.base.output).toBe('new-proxy');
  expect(restored.rules[0].source?.edits.fields?.output).toBe('new-local');
  const updated = refreshTrafficSource(restored, parse('domain:next.test'));
  expect(updated.rules[0].conditions.domain).toBe('domain:next.test\ndomain:mine.test');
  expect(updated.rules[0].output).toBe('new-local');
  const flat = importTrafficRules(
    table(),
    source,
    { proxy: 'proxy', local: 'local' },
    'replace',
    false,
  );
  expect(flat.source).toBeUndefined();
  expect(flat.rules[0].source).toBeUndefined();
  expect(flat.rules[0].conditions.domain).toContain('domain:mine.test');
  const appended = importTrafficRules(
    table(),
    source,
    { proxy: 'proxy', local: 'local' },
    'append',
  );
  expect(appended.rules[0].source).toBeUndefined();
});

it('maps every connection to Main, Direct and Block to the fixed v2rayN destinations', () => {
  const filter = makeNode('routing-filter', { x: 0, y: 0 }, 'filter');
  const main = makeNode('policy-group', { x: 0, y: 0 }, 'main');
  const direct = makeNode('direct-outbound', { x: 0, y: 0 }, 'direct');
  const block = makeNode('block-outbound', { x: 0, y: 0 }, 'block');
  const other = makeNode('proxy-chain', { x: 0, y: 0 }, 'other');
  const outputs = [main, main, direct, block, other].map((n, i) => ({ id: `out${i}`, name: n.id }));
  const graph = {
    name: 'Bindings',
    defaults: factoryDefaults(),
    mainOutboundId: main.id,
    nodes: [filter, main, direct, block, other],
    edges: [main, main, direct, block, other].map((n, i) => ({
      id: `e${i}`,
      source: filter.id,
      sourceHandle: outputs[i].id,
      target: n.id,
    })),
  };
  const rules = { ...table(), outputs };
  expect(outputs.map((o) => compatibleOutput(rules, graph, filter, o.id).fixed)).toEqual([
    'proxy',
    'proxy',
    'direct',
    'block',
    '',
  ]);
  expect(compatibleOutput(rules, graph, filter, 'out4').name).toBe(other.data.label);
  expect(
    compatibleOutput(
      { ...rules, outputs: [{ id: 'standalone', name: 'Main' }] },
      graph,
      filter,
      'standalone',
    ).fixed,
  ).toBe('proxy');
});

it('retains native projections and maps an ambiguity-only output on replacement', () => {
  const original = table(
    row(
      { domain: 'domain:a.test' },
      {
        native: {
          version: 1,
          original: { domain: ['domain:a.test'], special: 'keep' },
          projection: { domain: ['domain:a.test'] },
        },
      },
    ),
  );
  original.outputs.push({ id: 'ambiguity', name: 'Unknown owner' });
  original.tunAmbiguity = { action: 'allow', output: 'ambiguity' };
  const imported = parseTrafficRules(exportWayrillRules(original, 'Filter'));
  expect(rolesForTrafficImport(imported, 'replace').map((r) => r.id)).toContain('ambiguity');
  const restored = importTrafficRules(
    table(),
    imported,
    { proxy: 'proxy', local: 'local', ambiguity: newPresetOutput },
    'replace',
  );
  expect(restored.outputs.find((o) => o.id === restored.tunAmbiguity?.output)?.name).toBe(
    'Unknown owner',
  );
  expect(restored.rules[0].native).toEqual(original.rules[0].native);
});

it('preserves ordinary v2rayN OR/AND semantics, order, disabled rows and final default', () => {
  const original = table(
    row(
      {
        domain: 'domain:example.net\n# ignore',
        ip: '192.0.2.0/24',
        protocol: 'tls',
        port: '443',
        network: 'tcp',
        inboundTag: 'input',
      },
      { applications: [process] },
    ),
    row({ process: 'C:/Tools/' }, { id: 'disabled', enabled: false }),
  );
  const exported = exportCompatibleRules(original, destinations);
  const rows = JSON.parse(exported.text);
  expect(rows[0]).toMatchObject({
    domain: ['domain:example.net'],
    ip: ['192.0.2.0/24'],
    process: ['browser.exe'],
    protocol: ['tls'],
    port: '443',
    network: 'tcp',
    inboundTag: ['input'],
    outboundTag: 'My server',
  });
  expect(rows[1].enabled).toBe(false);
  const imported = parseTrafficRules(exported.text);
  expect(imported.defaultOutput).toBe('outbound:direct');
  expect(imported.rules).toHaveLength(2);
  expect(captureRuleVariants(imported.rules[0] as TableRule, 'native')).toEqual(
    captureRuleVariants(original.rules[0], 'native'),
  );
});

it('skips incompatible AND rules and selector-only rules rather than weakening them', () => {
  const service = {
    kind: 'service',
    mode: 'name',
    value: 'Dnscache',
    enabled: true,
    children: false,
  } as const;
  const original = table(
    row({ port: '443' }, { id: 'children', applications: [{ ...process, children: true }] }),
    row(
      { domain: 'domain:a.test' },
      { id: 'required-service', targetMatch: 'all', applications: [service] },
    ),
    row({ domain: 'domain:a.test', ip: '192.0.2.1' }, { id: 'both', targetMatch: 'all' }),
    row({ domain: 'domain:a.test', sourcePort: '1000' }, { id: 'source' }),
    row(
      { domain: 'domain:a.test' },
      {
        id: 'lua',
        native: {
          version: 1,
          original: { domain: ['domain:a.test'], lua: 'custom' },
          projection: { domain: ['domain:a.test'] },
        },
      },
    ),
  );
  const result = exportCompatibleRules(original, destinations);
  expect(JSON.parse(result.text)).toEqual([
    {
      type: 'field',
      network: 'tcp,udp',
      outboundTag: 'direct',
      enabled: true,
      remarks: 'Unmatched traffic',
    },
  ]);
  expect(result.omitted.filter((n) => n.includes('skipped'))).toHaveLength(5);
});

it('keeps representable alternatives while reporting omitted Windows selectors', () => {
  const result = exportCompatibleRules(
    table(
      row(
        { domain: 'domain:a.test' },
        { applications: [process, { ...process, children: true, value: 'parent.exe' }] },
      ),
    ),
    destinations,
  );
  expect(JSON.parse(result.text)[0]).toMatchObject({
    domain: ['domain:a.test'],
    process: ['browser.exe'],
  });
  expect(result.omitted.join(' ')).toContain('1 Windows');
  const mixed = exportCompatibleRules(
    table(
      row(
        { process: 'native.exe' },
        { applications: [process, { ...process, children: true, value: 'parent.exe' }] },
      ),
    ),
    destinations,
  );
  expect(JSON.parse(mixed.text)[0].process).toEqual(['native.exe', 'browser.exe']);
  expect(() =>
    exportCompatibleRules(table(row({ domain: 'domain:a.test' })), { proxy: '', local: 'direct' }),
  ).toThrow('valid v2rayN');
});

it('validates malformed Wayrill structures and version before binding anything', () => {
  const file = JSON.parse(exportWayrillRules(table(), 'Filter'));
  expect(() => parseTrafficRules(JSON.stringify({ ...file, version: 2 }))).toThrow('Unsupported');
  expect(() =>
    parseTrafficRules(
      JSON.stringify({ ...file, rules: [{ ...row({}), conditions: { domain: [1] } }] }),
    ),
  ).toThrow('text');
});
it('reimports 128 compatible rules plus their explicit final default', () => {
  const source = table(
    ...Array.from({ length: 128 }, (_, i) => row({ domain: `full:${i}.test` }, { id: `r${i}` })),
  );
  expect(parseTrafficRules(exportCompatibleRules(source, destinations).text).rules).toHaveLength(
    128,
  );
  const empty = table();
  empty.tunAmbiguity = { action: 'block', output: '' };
  const imported = parseTrafficRules(exportWayrillRules(empty, 'Empty'));
  expect(rolesForTrafficImport(imported, 'replace').map((o) => o.id)).toEqual(['proxy', 'local']);
});

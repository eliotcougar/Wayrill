import { describe, expect, it } from 'vitest';
import fixture from './fixtures/v2rayN-lab-routing.json';
import { parseTrafficRules, importTrafficRules, trafficImportBase } from './trafficRuleImport';
import { newPresetOutput } from './routingPresets';
import { routingRuleVariants, readRuleTable, tableSettings } from './rules';

const table = {
  outputs: [
    { id: 'proxy', name: 'Proxy' },
    { id: 'direct', name: 'Direct' },
    { id: 'block', name: 'Block' },
  ],
  rules: [
    {
      id: 'old',
      name: 'Old rule',
      enabled: true,
      matchAll: false,
      output: 'proxy',
      conditions: { domain: 'old.example' },
    },
  ],
  defaultOutput: 'proxy',
};
const bindings = {
  'outbound:proxy': 'proxy',
  'outbound:direct': 'direct',
  'outbound:block': 'block',
};
const parse = (value: unknown) => parseTrafficRules(JSON.stringify(value));
describe('v2rayN traffic import', () => {
  it('preserves the supplied lab rules in order and moves their final catch-all to the default', () => {
    const imported = parse(fixture),
      original = structuredClone(table),
      next = importTrafficRules(table, imported, bindings, 'replace');
    expect(imported.sourceRules).toBe(12);
    expect(next.rules).toHaveLength(11);
    expect(next.defaultOutput).toBe('direct');
    expect(next.outputs).toEqual(table.outputs);
    expect(table).toEqual(original);
    for (const [index, raw] of fixture.slice(0, -1).entries()) {
      const { outboundTag, ...fields } = raw;
      const match = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'type'));
      expect(routingRuleVariants(next.rules[index])).toEqual([match]);
      expect(next.rules[index].output).toBe(outboundTag);
    }
    expect(readRuleTable(tableSettings(next))).toEqual(next);
  });
  it('appends conditional rows while retaining existing order, outputs and default', () => {
    const next = importTrafficRules(table, parse(fixture), bindings, 'append');
    expect(next.rules).toHaveLength(12);
    expect(next.rules[0]).toEqual(table.rules[0]);
    expect(next.defaultOutput).toBe('proxy');
    expect(next.rules.every((r) => !r.matchAll)).toBe(true);
  });
  it('accepts PascalCase RuleSet JSON and optional graph strategy', () => {
    const source = parse({
      RuleSet: JSON.stringify([
        {
          Type: 'field',
          Remarks: '🦊 Work',
          Domain: ['work.example'],
          OutboundTag: 'proxy',
          Enabled: false,
        },
      ]),
      DomainStrategy: 'IPOnDemand',
    });
    expect(source.domainStrategy).toBe('IPOnDemand');
    expect(source.rules[0]).toMatchObject({
      name: '🦊 Work',
      enabled: false,
      targetMatch: 'any',
      conditions: { domain: 'work.example' },
    });
  });
  it('distinguishes v2rayN OR from native Xray AND', () => {
    const rule = { domain: ['a.example'], ip: ['192.0.2.1'], port: '443', outboundTag: 'proxy' };
    const legacy = importTrafficRules(table, parse([rule]), bindings, 'replace').rules[0];
    const native = importTrafficRules(
      table,
      parse({ routing: { domainStrategy: 'AsIs', rules: [rule] } }),
      bindings,
      'replace',
    ).rules[0];
    expect(routingRuleVariants(legacy)).toEqual([
      { domain: ['a.example'], port: '443' },
      { ip: ['192.0.2.1'], port: '443' },
    ]);
    expect(routingRuleVariants(native)).toEqual([
      { domain: ['a.example'], ip: ['192.0.2.1'], port: '443' },
    ]);
  });
  it('imports branch blocks with their enabled state, child processes, packages and services', () => {
    const source = parse([
      {
        Type: 'field',
        Enabled: false,
        InboundTag: ['v2rayN-block-rule-requires-new-editor'],
        OutboundTag: 'proxy',
        Blocks: {
          Version: 1,
          Enabled: true,
          Filters: [
            { Selector: 0, Values: ['#comment', 'domain:example.org'] },
            { Selector: 2, Values: ['80', '443'] },
            {
              Selector: 3,
              Applications: [
                { Value: 'C:\\Apps\\browser.exe', Mode: 0, IncludeChildren: true, Enabled: true },
              ],
            },
            {
              Selector: 4,
              Applications: [
                { Value: 'Example.App_abc', Mode: 0, IncludeChildren: true, Enabled: false },
              ],
            },
            { Selector: 8, Applications: [{ Value: 'Dnscache', Mode: 2, IncludeChildren: false }] },
          ],
        },
      },
    ]);
    expect(source.rules[0]).toMatchObject({
      enabled: true,
      targetMatch: 'any',
      conditions: { domain: 'domain:example.org', port: '80,443' },
      applications: [
        {
          kind: 'process',
          value: 'C:/Apps/browser.exe',
          mode: 'path',
          children: true,
          enabled: true,
        },
        { kind: 'package', value: 'Example.App_abc', mode: 'name', children: true, enabled: false },
        { kind: 'service', value: 'Dnscache', mode: 'name', children: false, enabled: true },
      ],
    });
    expect(source.rules[0].conditions.inboundTag).toBeUndefined();
  });
  it('keeps disabled trailing rules after folding the last enabled catch-all', () => {
    const source = parse([
      { network: 'tcp,udp', outboundTag: 'direct' },
      { domain: ['later.example'], outboundTag: 'proxy', enabled: false },
    ]);
    expect(source.defaultOutput).toBe('outbound:direct');
    expect(source.rules).toHaveLength(1);
    expect(source.rules[0].enabled).toBe(false);
  });
  it('leaves earlier catch-alls as explicit rules for unreachable-rule diagnostics', () => {
    const source = parse([
      { network: 'tcp,udp', outboundTag: 'direct' },
      { domain: ['later.example'], outboundTag: 'proxy' },
    ]);
    expect(source.defaultOutput).toBeUndefined();
    expect(source.rules[0].matchAll).toBe(true);
  });
  it('does not broaden empty or comment-only legacy destination rules', () => {
    const source = parse([
      { domain: ['# ignored'], port: '443', outboundTag: 'direct' },
      { outboundTag: 'proxy' },
    ]);
    expect(source.rules.every((r) => !r.enabled)).toBe(true);
    expect(source.defaultOutput).toBeUndefined();
  });
  it('restores escaped commas, omits DNS-only rules with a note and retains ALL rules', () => {
    const source = parse([
      { domain: ['regexp:a<COMMA>b'], outboundTag: 'proxy', RuleType: 0 },
      { domain: ['dns.example'], outboundTag: 'direct', RuleType: 2 },
    ]);
    expect(source.rules[0].conditions.domain).toBe('regexp:a,b');
    expect(source.rules).toHaveLength(1);
    expect(source.notes.join(' ')).toContain('DNS-only');
  });
  it('creates unique names without replacing output IDs and permits explicit many-to-one binding', () => {
    const source = parse([{ domain: ['a.example'], outboundTag: 'proxy' }]);
    const next = importTrafficRules(
      table,
      source,
      { 'outbound:proxy': newPresetOutput },
      'replace',
    );
    expect(next.outputs.slice(0, 3)).toEqual(table.outputs);
    expect(next.outputs[3].name).toBe('proxy 2');
    expect(next.rules[0].output).toBe(next.outputs[3].id);
    const duplicate = parse([
      { domain: ['a.example'], outboundTag: 'one' },
      { domain: ['b.example'], outboundTag: 'two' },
    ]);
    const bound = importTrafficRules(
      table,
      duplicate,
      { 'outbound:one': 'direct', 'outbound:two': 'direct' },
      'replace',
    );
    expect(bound.outputs).toEqual(table.outputs);
    expect(bound.rules.every((r) => r.output === 'direct')).toBe(true);
  });
  it('keeps outbound and balancer namespaces distinct', () => {
    const source = parse({
      rules: [
        { domain: ['a.example'], outboundTag: 'same' },
        { domain: ['b.example'], balancerTag: 'same' },
      ],
    });
    expect(source.roles.map((r) => r.id)).toEqual(['outbound:same', 'balancer:same']);
  });
  it('accepts BOM and comments with duplicate-key protection', () => {
    expect(
      parseTrafficRules('\ufeff[ /* comment */ {"domain":["a.example"], "outboundTag":"proxy"}]')
        .rules,
    ).toHaveLength(1);
    expect(() => parseTrafficRules('[{"outboundTag":"direct","outboundTag":"proxy"}]')).toThrow(
      'Duplicate',
    );
  });
  it.each([
    [{ Domain: ['a.example'], domain: ['b.example'], outboundTag: 'proxy' }],
    [{ domain: 'a.example', outboundTag: 'proxy' }],
    [{ domain: ['a.example'], outboundTag: 'proxy', enabled: 'false' }],
    [{ domain: ['a.example'], outboundTag: 'proxy', strangeMatch: true }],
    [{ domain: ['a.example'], outboundTag: 'proxy', balancerTag: 'group' }],
    [{ protocol: ['unsupported'], outboundTag: 'proxy' }],
    [{ domain: ['a.example'], outboundTag: 'proxy', Blocks: { Version: 2, Filters: [] } }],
  ])('rejects ambiguous/unsupported input: %j', (value) => {
    expect(() => parse(value)).toThrow();
  });
  it('refuses capacity overflow or missing output bindings without mutation', () => {
    const source = parse(fixture),
      original = structuredClone(table);
    expect(() => importTrafficRules(table, source, {}, 'replace')).toThrow('Choose an output');
    expect(() =>
      parse(Array.from({ length: 129 }, () => ({ domain: ['a.example'], outboundTag: 'proxy' }))),
    ).toThrow('128');
    expect(() =>
      importTrafficRules(
        {
          ...table,
          rules: Array.from({ length: 128 }, (_, i) => ({ ...table.rules[0], id: `r-${i}` })),
        },
        source,
        bindings,
        'append',
      ),
    ).toThrow('128');
    expect(table).toEqual(original);
  });
});

it('normalizes equivalent network order and avoids new unused fallback outputs when appending', () => {
  const source = parse([
    { domain: ['a.example'], network: 'udp, tcp', outboundTag: 'proxy' },
    { port: '0-65535', outboundTag: 'unused-default' },
  ]);
  expect(source.rules[0].conditions.network).toBe('tcp,udp');
  const next = importTrafficRules(table, source, { 'outbound:proxy': 'proxy' }, 'append');
  expect(next.outputs).toEqual(table.outputs);
  expect(next.defaultOutput).toBe(table.defaultOutput);
});

describe('fresh rule import output ownership', () => {
  const fresh = {
    outputs: [
      { id: 'preferred', name: 'Preferred' },
      { id: 'default', name: 'Default' },
    ],
    rules: [],
    defaultOutput: 'default',
  };
  const source = parseTrafficRules(
    JSON.stringify([
      { type: 'field', outboundTag: 'proxy', domain: ['example.com'], enabled: true },
      { outboundTag: 'direct', port: '0-65535' },
    ]),
  );
  const bindings = Object.fromEntries(source.roles.map((role) => [role.id, newPresetOutput]));
  it('replaces untouched placeholders and produces a usable new fallback', () => {
    const result = importTrafficRules(
      trafficImportBase(fresh, source, bindings, 'replace', false),
      source,
      bindings,
      'replace',
    );
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs.some((output) => output.id === result.defaultOutput)).toBe(true);
    expect(result.outputs.some((output) => ['preferred', 'default'].includes(output.id))).toBe(
      false,
    );
  });
  it('preserves connected, renamed and appended output identities', () => {
    expect(trafficImportBase(fresh, source, bindings, 'replace', true)).toBe(fresh);
    expect(trafficImportBase(fresh, source, bindings, 'append', false)).toBe(fresh);
    const renamed = { ...fresh, outputs: [{ id: 'preferred', name: 'Mine' }, fresh.outputs[1]] };
    expect(trafficImportBase(renamed, source, bindings, 'replace', false)).toBe(renamed);
  });
  it('keeps the current fallback when the import has no catch-all', () => {
    const partial = { ...source, defaultOutput: undefined };
    expect(trafficImportBase(fresh, partial, bindings, 'replace', false)).toBe(fresh);
  });
});

import { describe, expect, it } from 'vitest';
import fixture from './fixtures/v2rayN-lab-routing.json';
import { parseTrafficRules, importTrafficRules } from './trafficRuleImport';
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
  it('does not broaden empty or comment-only legacy destination rules', () => {
    const source = parse([
      { domain: ['# ignored'], port: '443', outboundTag: 'direct' },
      { outboundTag: 'proxy' },
    ]);
    expect(source.rules.every((r) => !r.enabled)).toBe(true);
    expect(source.defaultOutput).toBeUndefined();
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

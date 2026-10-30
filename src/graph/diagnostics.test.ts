import { describe, expect, it } from 'vitest';
import { diagnoseRuntimeGraph } from './diagnostics';
import { createTrafficExample } from './example';
import { makeNode } from './catalog';
import { readRuleTable, tableSettings } from './rules';
import { parseGraph, serializeGraph } from './model';
describe('Runtime graph diagnostics', () => {
  it('accepts the complete current example and its round trip', () => {
    for (const g of [createTrafficExample(), parseGraph(serializeGraph(createTrafficExample()))])
      expect(diagnoseRuntimeGraph(g).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('reports localhost listener collisions and reserved tags while accepting native process metadata', () => {
    const g = createTrafficExample();
    Object.assign(g.nodes.find((n) => n.id === 'socks')!.data.settings, {
      listen: 'localhost',
      port: 2081,
    });
    g.nodes.find((n) => n.id === 'preferred')!.data.settings.tag = 'wr-test';
    const f = g.nodes.find((n) => n.id === 'routes')!,
      table = readRuleTable(f.data.settings);
    table.rules[0].conditions.process = 'browser.exe';
    Object.assign(f.data.settings, tableSettings(table));
    const issues = diagnoseRuntimeGraph(g);
    expect(issues.some((i) => i.nodeId === 'socks' && i.message.includes('overlapping'))).toBe(
      true,
    );
    expect(issues.some((i) => i.nodeId === 'preferred' && i.message.includes('reserved'))).toBe(
      true,
    );
    expect(issues.some((i) => i.message.includes('metadata unavailable'))).toBe(false);
  });
  it('warns about unreachable outbounds and duplicate or shadowed enabled rules', () => {
    const g = createTrafficExample();
    g.nodes.push(makeNode('direct-outbound', { x: 0, y: 0 }, 'unused'));
    g.nodes.at(-1)!.data.settings.tag = 'unused';
    const f = g.nodes.find((n) => n.id === 'routes')!,
      table = readRuleTable(f.data.settings);
    table.rules[1] = { ...table.rules[0], id: 'duplicate', name: 'Duplicate' };
    Object.assign(f.data.settings, tableSettings(table));
    const issues = diagnoseRuntimeGraph(g);
    expect(issues.some((i) => i.nodeId === 'unused' && i.message.includes('unreachable'))).toBe(
      true,
    );
    expect(
      issues.some(
        (i) => i.nodeId === 'routes' && i.message.includes('Duplicate cannot be reached'),
      ),
    ).toBe(true);
  });
});

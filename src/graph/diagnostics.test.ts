import { describe, expect, it, vi } from 'vitest';
import { diagnoseRuntimeGraph } from './diagnostics';
import { createTrafficExample } from './example';
import { makeNode } from './catalog';
import { readRuleTable, tableSettings } from './rules';

import { analyzeGraph } from './analysis';
import * as runtime from './runtime';
import { importXrayConfig } from './xrayImport';
describe('Runtime graph diagnostics', () => {
  it('diagnoses inbound conditions using whole selected tags, including literal commas', () => {
    const graph = createTrafficExample();
    const input = graph.nodes.find((n) => n.id === 'socks')!;
    input.data.settings.tag = 'work,laptop';
    const filter = graph.nodes.find((n) => n.id === 'routes')!;
    const table = readRuleTable(filter.data.settings);
    table.rules[0].conditions.inboundTag = 'work,laptop';
    table.rules[1].conditions.inboundTag = 'laptop';
    Object.assign(filter.data.settings, tableSettings(table));
    expect(
      diagnoseRuntimeGraph(graph)
        .filter((issue) => issue.message.includes('excludes every inbound'))
        .map((issue) => issue.rowId),
    ).toEqual([table.rules[1].id]);
  });
  it('checks the actual runtime configuration for an imported graph', () => {
    const graph = importXrayConfig(
      JSON.stringify({ outbounds: [{ protocol: 'freedom', tag: 'direct' }] }),
    );
    const compilation = runtime.compileRuntimeGraph(graph);
    compilation.config.metrics = { listen: '0.0.0.0:20500' };
    const compile = vi.spyOn(runtime, 'compileRuntimeGraph').mockReturnValue(compilation);
    try {
      const result = analyzeGraph(graph);
      expect(compile).toHaveBeenCalledExactlyOnceWith(graph);
      expect(result.compilation).toBe(compilation);
      expect(result.issues.some((issue) => issue.message.includes('Metrics can be exported'))).toBe(
        true,
      );
    } finally {
      compile.mockRestore();
    }
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

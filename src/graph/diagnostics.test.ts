import { describe, expect, it } from 'vitest';
import { diagnoseRuntimeGraph } from './diagnostics';
import { compileRuntimeGraph } from './runtime';
import { createTrafficExample } from './example';
import { makeNode, getOutputPorts } from './catalog';
import { factoryDefaults } from './defaults';
import type { GraphState } from './types';
import { readRuleTable, tableSettings } from './rules';
import { parseGraph, serializeGraph } from './model';
describe('Runtime graph diagnostics', () => {
  it('accepts the complete current example and its round trip', () => {
    for (const g of [createTrafficExample(), parseGraph(serializeGraph(createTrafficExample()))])
      expect(diagnoseRuntimeGraph(g).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('finds several independent errors in one pass and attaches them to their nodes', () => {
    const g = createTrafficExample();
    g.edges = g.edges.filter((e) => e.source !== 'http');
    g.nodes.find((n) => n.id === 'socks')!.data.settings.listen = '999.1.1.1';
    g.nodes.find((n) => n.id === 'preferred')!.data.settings.dialerProxy = 'missing';
    const errors = diagnoseRuntimeGraph(g).filter((i) => i.severity === 'error');
    expect(errors.some((i) => i.nodeId === 'http' && i.message.includes('Data'))).toBe(true);
    expect(errors.some((i) => i.nodeId === 'http' && i.message.includes('DNS'))).toBe(true);
    expect(errors.some((i) => i.nodeId === 'socks' && i.fieldKey === 'listen')).toBe(true);
    expect(errors.some((i) => i.nodeId === 'preferred' && i.fieldKey === 'dialerProxy')).toBe(true);
  });
  it.each(['http-data', 'http-dns', 'routes-vless', 'routes-block'])(
    'reports a disconnected required path: %s',
    (id) => {
      const g = createTrafficExample();
      g.edges = g.edges.filter((e) => e.id !== id);
      expect(
        diagnoseRuntimeGraph(g).some(
          (i) => i.severity === 'error' && i.nodeId && i.message.includes('Connect'),
        ),
      ).toBe(true);
    },
  );
  it('catches duplicate paths, missing endpoints, invalid ports and routing loops in editor state', () => {
    const g = createTrafficExample();
    g.edges.push({ ...g.edges[0], id: 'duplicate-output' });
    g.edges.push({
      id: 'dangling',
      source: 'http',
      sourceHandle: 'fake',
      target: 'missing',
      targetHandle: 'in',
    });
    g.edges.push({
      id: 'loop',
      source: 'routes',
      sourceHandle: 'preferred',
      target: 'routes',
      targetHandle: 'in',
    });
    const messages = diagnoseRuntimeGraph(g)
      .filter((i) => i.severity === 'error')
      .map((i) => i.message)
      .join('\n');
    expect(messages).toMatch(/multiple paths/);
    expect(messages).toMatch(/missing node/);
    expect(messages).toMatch(/routing loop/);
  });
  it('reports localhost listener collisions and reserved tags while accepting native process metadata', () => {
    const g = createTrafficExample();
    Object.assign(g.nodes.find((n) => n.id === 'socks')!.data.settings, {
      listen: 'localhost',
      port: 2081,
    });
    g.nodes.find((n) => n.id === 'preferred')!.data.settings.tag = 'wayrill-runtime-test';
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
  it('does not require disconnected outputs of disabled drafts', () => {
    const g = createTrafficExample(),
      f = g.nodes.find((n) => n.id === 'routes')!,
      table = readRuleTable(f.data.settings);
    table.rules[0].enabled = false;
    table.rules[0].conditions.process = 'browser.exe';
    table.rules[0].conditions.port = 'invalid';
    Object.assign(f.data.settings, tableSettings(table));
    g.edges = g.edges.filter((e) => e.id !== 'routes-block');
    expect(diagnoseRuntimeGraph(g).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('detects an incomplete child filter at its missing output', () => {
    const g = createTrafficExample(),
      second = makeNode('routing-filter', { x: 0, y: 0 }, 'second');
    g.nodes.push(second);
    g.edges.find((e) => e.id === 'routes-vless')!.target = 'second';
    expect(
      diagnoseRuntimeGraph(g).some((i) => i.nodeId === 'second' && i.message.includes('Connect')),
    ).toBe(true);
    expect(() => compileRuntimeGraph(g)).toThrow(/Connect the default/);
  });
  it.each(['tcp', 'udp', 'tcp,udp'])(
    'preserves mixed-input scope and top-to-bottom ordering for %s rules',
    (network) => {
      const g = createTrafficExample(),
        f = g.nodes.find((n) => n.id === 'routes')!,
        table = readRuleTable(f.data.settings);
      table.rules[0].conditions.network = network;
      Object.assign(f.data.settings, tableSettings(table));
      const compiled = compileRuntimeGraph(g),
        rules = (compiled.config.routing as { rules: Record<string, unknown>[] }).rules;
      expect(rules.filter((r) => r.outboundTag === 'block').map((r) => r.inboundTag)).toEqual([
        ['local-socks'],
        ['local-http'],
      ]);
      expect(
        rules.filter((r) => r.outboundTag === 'block').every((r) => r.network === network),
      ).toBe(true);
    },
  );
});

it.each(['', '853'])(
  'validates the declared Mixed ports, including encrypted ports %s',
  (encryptedDnsPorts) => {
    const mixed = makeNode('proxy-inbound', { x: 0, y: 0 }, 'mixed'),
      direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
    mixed.data.settings.encryptedDnsPorts = encryptedDnsPorts;
    const graph: GraphState = {
      name: 'Mixed ports',
      defaults: factoryDefaults(),
      nodes: [mixed, direct],
      edges: getOutputPorts(mixed.data.kind, mixed.data).map((port) => ({
        id: port,
        source: mixed.id,
        sourceHandle: port,
        target: direct.id,
        targetHandle: 'in',
      })),
    };
    expect(diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'error')).toEqual([]);
    expect(() => compileRuntimeGraph(graph)).not.toThrow();
    for (const port of getOutputPorts(mixed.data.kind, mixed.data)) {
      const disconnected = { ...graph, edges: graph.edges.filter((e) => e.sourceHandle !== port) };
      const errors = diagnoseRuntimeGraph(disconnected).filter(
        (i) => i.severity === 'error' && i.nodeId === mixed.id,
      );
      expect(errors.some((i) => i.portId === port)).toBe(true);
      expect(errors.some((i) => i.portId === 'traffic')).toBe(false);
    }
  },
);

it('distinguishes application identities and any/all semantics in shadow diagnostics', () => {
  const g = createTrafficExample(),
    node = g.nodes.find((n) => n.id === 'routes')!,
    table = readRuleTable(node.data.settings);
  const base = {
    ...table.rules[0],
    conditions: {},
    matchAll: false,
    applications: [
      {
        kind: 'process' as const,
        value: 'first.exe',
        mode: 'name' as const,
        children: false,
        enabled: true,
      },
    ],
  };
  table.rules = [
    { ...base, id: 'first', name: 'First' },
    {
      ...base,
      id: 'second',
      name: 'Second',
      applications: [{ ...base.applications[0], value: 'second.exe' }],
    },
    { ...base, id: 'duplicate', name: 'Duplicate' },
  ];
  Object.assign(node.data.settings, tableSettings(table));
  const shadow = diagnoseRuntimeGraph(g).filter((i) => i.message.includes('cannot be reached'));
  expect(shadow.map((i) => i.rowId)).toEqual(['duplicate']);
});

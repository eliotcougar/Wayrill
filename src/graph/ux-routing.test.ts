import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { captureRuleVariants, type TableRule } from './rules';
import { factoryDefaults } from './defaults';
import type { GraphState } from './types';
const row: TableRule = {
  id: 'r',
  name: 'Composite',
  enabled: true,
  output: 'match',
  matchAll: false,
  conditions: { domain: 'full:work.example', ip: '192.0.2.0/24', port: '443', network: 'tcp' },
  applications: [
    { kind: 'process', value: 'work.exe', mode: 'name', children: true, enabled: true },
  ],
};
describe('walkthrough routing corrections', () => {
  it('matches domain OR IP OR parent process with additive network/port predicates', () => {
    expect(() => captureRuleVariants(row)).toThrow('child-process');
    expect(
      captureRuleVariants({
        ...row,
        applications: row.applications!.map((a) => ({ ...a, children: false })),
      }),
    ).toEqual([
      { port: '443', network: 'tcp', domain: ['full:work.example'] },
      { port: '443', network: 'tcp', ip: ['192.0.2.0/24'] },
      { port: '443', network: 'tcp', process: ['work.exe'] },
    ]);
    expect(captureRuleVariants(row, 'capture')[2]).toHaveProperty('_wayrillApplications');
  });
  it('does not turn an unsupported Windows service identity into a catch-all', () => {
    const rule = {
      ...row,
      conditions: {},
      applications: [
        {
          kind: 'service' as const,
          value: 'Svc',
          mode: 'name' as const,
          children: false,
          enabled: true,
        },
      ],
    };
    expect(() => captureRuleVariants(rule)).toThrow('requires TUN or WinDivert');
    expect(() => captureRuleVariants({ ...rule, conditions: { port: '443' } })).toThrow(
      'requires TUN or WinDivert',
    );
  });
});

it('checks plaintext DNS provenance both when attaching a handler and when joining existing filter branches', async () => {
  const { connectionProblem, structureProblems } = await import('./structure');
  const input = makeNode('proxy-inbound', { x: 0, y: 0 }, 'mixed'),
    f1 = makeNode('routing-filter', { x: 300, y: 0 }, 'f1'),
    f2 = makeNode('routing-filter', { x: 600, y: 0 }, 'f2'),
    dns = makeNode('dns-handler', { x: 900, y: 0 }, 'dns');
  const edge = (source: string, target: string, sourceHandle: string) => ({
    id: source + target + sourceHandle,
    source,
    target,
    sourceHandle,
    targetHandle: 'in',
  });
  const graph: GraphState = {
    name: 'DNS provenance',
    defaults: factoryDefaults(),
    nodes: [input, f1, f2, dns],
    edges: [edge(input.id, f1.id, 'dns')],
  };
  expect(connectionProblem(graph, edge(f1.id, dns.id, 'default'))).toBeNull();
  graph.edges.push(edge(f1.id, dns.id, 'default'));
  expect(connectionProblem(graph, edge(input.id, f2.id, 'data'))).toBeNull();
  graph.edges.push(edge(input.id, f2.id, 'data'));
  expect(connectionProblem(graph, edge(f2.id, f1.id, 'default'))).toMatch(/plaintext DNS/);
  graph.edges.push(edge(f2.id, f1.id, 'default'));
  expect(structureProblems(graph).some((issue) => issue.message.includes('plaintext DNS'))).toBe(
    true,
  );
});

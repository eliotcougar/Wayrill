import { describe, expect, it } from 'vitest';
import { makeNode, getOutputPorts } from './catalog';
import { captureRuleVariants, tableSettings, type TableRule } from './rules';
import { factoryDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { clearNodePosition } from './placement';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
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
  it('routes shared Mixed and WinDivert inbounds through one filter with per-input child tracking', async () => {
    const mixed = makeNode('proxy-inbound', { x: 0, y: 0 }, 'mixed'),
      captured = makeNode('windivert-inbound', { x: 0, y: 300 }, 'capture'),
      filter = makeNode('routing-filter', { x: 350, y: 0 }, 'filter'),
      direct = makeNode('direct-outbound', { x: 700, y: 0 }, 'direct'),
      block = makeNode('block-outbound', { x: 700, y: 300 }, 'block');
    Object.assign(
      filter.data.settings,
      tableSettings({
        outputs: [
          { id: 'match', name: 'Work' },
          { id: 'fallback', name: 'Else' },
        ],
        rules: [row],
        defaultOutput: 'fallback',
      }),
    );
    const graph: GraphState = {
      name: 'Mixed capabilities',
      defaults: factoryDefaults(),
      nodes: [mixed, captured, filter, direct, block],
      edges: [
        ...[mixed, captured].flatMap((n) =>
          getOutputPorts(n.data.kind, n.data).map((p) => ({
            id: n.id + p,
            source: n.id,
            sourceHandle: p,
            target: p === 'data' ? filter.id : direct.id,
            targetHandle: 'in',
          })),
        ),
        {
          id: 'work',
          source: filter.id,
          sourceHandle: 'match',
          target: direct.id,
          targetHandle: 'in',
        },
        {
          id: 'else',
          source: filter.id,
          sourceHandle: 'fallback',
          target: block.id,
          targetHandle: 'in',
        },
      ],
    };
    const shared = compileRuntimeGraph(graph);
    const sharedRules = (shared.config.routing as { rules: Record<string, unknown>[] }).rules;
    expect(shared.capture?.inputs[0].predicates[0][0].children).toBe(true);
    expect(sharedRules.some((r) => r.process)).toBe(false);
    expect(
      sharedRules.some((r) => r.user && JSON.stringify(r.inboundTag) === '["captured-traffic"]'),
    ).toBe(true);
    filter.data.settings.rules = JSON.stringify([
      { ...row, applications: row.applications!.map((a) => ({ ...a, children: false })) },
    ]);
    const result = compileRuntimeGraph(graph),
      rules = (result.config.routing as { rules: Record<string, unknown>[] }).rules;
    expect(rules.some((r) => r.process && JSON.stringify(r.inboundTag) === '["local-proxy"]')).toBe(
      true,
    );
    expect(result.capture?.inputs[0].predicates[0][0].children).toBe(false);
    if (process.env.WAYRILL_UX_FIXTURE_DIRECTORY) {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      writeFileSync(
        join(process.env.WAYRILL_UX_FIXTURE_DIRECTORY, 'public-shared-input.json'),
        JSON.stringify(result, null, 2),
      );
    }

    expect(
      rules.some((r) => r.user && JSON.stringify(r.inboundTag) === '["captured-traffic"]'),
    ).toBe(true);
  });
  it('keeps native domain AND IP rules functionally unchanged on import/export', () => {
    const config = {
      inbounds: [
        { tag: 'local', protocol: 'mixed', listen: '127.0.0.1', port: 4080, settings: {} },
      ],
      outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
      routing: {
        rules: [
          {
            type: 'field',
            domain: ['full:work.example'],
            ip: ['192.0.2.0/24'],
            outboundTag: 'direct',
          },
        ],
      },
    };
    expect(compileXrayGraph(importXrayConfig(JSON.stringify(config))).config).toEqual(config);
  });
  it('places a new card near its drop point without covering measured cards', () => {
    const node = {
      ...makeNode('routing-filter', { x: 100, y: 100 }),
      measured: { width: 400, height: 600 },
    };
    expect(clearNodePosition([node], { x: 110, y: 110 })).not.toEqual({ x: 110, y: 110 });
    expect(clearNodePosition([node], { x: 900, y: 100 })).toEqual({ x: 900, y: 100 });
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
it('flags overlapping plain and encrypted classification sets', async () => {
  const { inboundProblems } = await import('./inbounds');
  const node = makeNode('proxy-inbound', { x: 0, y: 0 });
  node.data.settings.dnsPorts = '53,850-860';
  node.data.settings.encryptedDnsPorts = '853';
  expect(inboundProblems(node.data).some((issue) => issue.message.includes('overlap'))).toBe(true);
});

it('uses default classification when optional port settings are absent', async () => {
  const { validateSettings } = await import('./catalog');
  const node = makeNode('proxy-inbound', { x: 0, y: 0 });
  delete node.data.settings.dnsPorts;
  delete node.data.settings.encryptedDnsPorts;
  expect(validateSettings(node.data.kind, node.data.settings)).toMatchObject({
    dnsPorts: '53',
    encryptedDnsPorts: '',
  });
});

it.each(['service', 'package'] as const)(
  'cannot discard an identity that is required with a domain (%s)',
  (kind) => {
    const application = {
      kind,
      value: kind === 'service' ? 'Svc' : 'App_family',
      mode: 'name' as const,
      children: false,
      enabled: true,
    };
    const restricted = {
      ...row,
      targetMatch: 'all' as const,
      applications: [application],
      conditions: { domain: 'full:private.example', port: '443', network: 'tcp' },
    };
    expect(() => captureRuleVariants(restricted)).toThrow('requires TUN or WinDivert');
    expect(captureRuleVariants(restricted, 'capture')).toEqual([
      {
        domain: ['full:private.example'],
        port: '443',
        network: 'tcp',
        _wayrillApplications: [JSON.stringify([application])],
      },
    ]);
  },
);
it.each(['service', 'package'] as const)(
  'cannot replace an unavailable identity with its additive port condition (%s)',
  (kind) => {
    const applications = [
      { kind, value: 'identity', mode: 'name' as const, children: false, enabled: true },
    ];
    expect(() =>
      captureRuleVariants({
        ...row,
        targetMatch: 'any',
        applications,
        conditions: { port: '443', network: 'tcp' },
      }),
    ).toThrow('requires TUN or WinDivert');
    expect(() =>
      captureRuleVariants({
        ...row,
        targetMatch: 'any',
        applications,
        conditions: { domain: 'full:public.example', port: '443' },
      }),
    ).toThrow('requires TUN or WinDivert');
  },
);

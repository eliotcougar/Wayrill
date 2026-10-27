import { expect, it } from 'vitest';
import { applyStashedProfile } from './graph';
import { importProfiles } from './import';
import { createPolicyExample } from '../graph/policyExample';
import { importXrayConfig } from '../graph/xrayImport';
import { compileRuntimeGraph } from '../graph/runtime';
const entry = importProfiles(
  'vless://ba640cce-3c50-46f5-8406-bf36f35b5c90@public.example.net:443?security=tls#Public replacement',
).groups[0].entries[0];
it('replaces an authored policy with a terminal outbound while retaining its identity, tag and incoming routes', () => {
  const graph = createPolicyExample();
  const before = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  const incoming = graph.edges.filter((e) => e.target === before.id);
  expect(graph.edges.some((e) => e.source === before.id)).toBe(true);
  const next = applyStashedProfile(graph, entry, { x: 999, y: 999 }, before.id);
  const after = next.nodes.find((n) => n.id === before.id)!;
  expect(after.position).toEqual(before.position);
  expect(after.data.settings.tag).toBe(before.data.settings.tag);
  expect(next.edges.filter((e) => e.target === before.id).map((e) => e.id)).toEqual(
    incoming.map((e) => e.id),
  );
  expect(next.edges.filter((e) => e.source === before.id)).toEqual(
    graph.edges.filter((e) => e.source === before.id).map((e) => ({ ...e, selected: false })),
  );
  expect(graph.nodes.find((n) => n.id === before.id)?.data.kind).toBe('policy-group');
  expect(compileRuntimeGraph(next).config.observatory).toMatchObject({
    subjectSelector: ['wayrill-observed-policy-group'],
  });
  expect(
    compileRuntimeGraph({
      ...next,
      nodes: next.nodes.filter((n) => n.data.kind !== 'observatory'),
      edges: next.edges.filter((e) => e.sourceHandle !== 'observation'),
    }).config.routing,
  ).toBeDefined();
});
const imported = () =>
  importXrayConfig(
    JSON.stringify({
      inbounds: [
        {
          tag: 'local',
          listen: '127.0.0.1',
          port: 20901,
          protocol: 'socks',
          settings: { udp: true },
        },
      ],
      outbounds: [
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole' },
      ],
      routing: {
        rules: [{ type: 'field', inboundTag: ['local'], balancerTag: 'group' }],
        balancers: [{ tag: 'group', selector: ['direct'], strategy: { type: 'random' } }],
      },
    }),
  );
it('replaces a native outbound in its existing section order without changing its routing tag', () => {
  const graph = imported();
  const id = graph.xray!.outboundOrder[0];
  const next = applyStashedProfile(graph, entry, { x: 999, y: 999 }, id);
  expect(next.xray!.outboundOrder).toEqual(graph.xray!.outboundOrder);
  const result = compileRuntimeGraph(next).config.outbounds as Record<string, unknown>[];
  expect(result[0]).toMatchObject({ tag: 'direct', protocol: 'vless' });
  expect(result[1]).toMatchObject({ tag: 'block', protocol: 'blackhole' });
});
it('moves a replaced native policy to outbound ordering and projects its routed target as an outbound', () => {
  const graph = imported();
  const id = graph.xray!.balancerOrder[0];
  const next = applyStashedProfile(graph, entry, { x: 999, y: 999 }, id);
  expect(next.xray!.balancerOrder).not.toContain(id);
  expect(next.xray!.outboundOrder).toContain(id);
  const result = compileRuntimeGraph(next).config;
  const routing = result.routing as { rules: Record<string, unknown>[]; balancers?: unknown[] };
  expect(routing.rules.some((r) => r.outboundTag === 'group')).toBe(true);
  expect(routing.rules.some((r) => r.balancerTag === 'group')).toBe(false);
  expect(routing.balancers ?? []).toHaveLength(0);
  expect(
    (result.outbounds as Record<string, unknown>[]).some(
      (o) => o.tag === 'group' && o.protocol === 'vless',
    ),
  ).toBe(true);
});

it('preserves Observation identity through plain, chain and policy replacement', () => {
  let graph = createPolicyExample();
  const id = graph.nodes.find((n) => n.data.kind === 'policy-group')!.id;
  const original = graph.edges.find((e) => e.source === id && e.sourceHandle === 'observation')!;
  const policy = structuredClone(graph.nodes.find((n) => n.id === id)!);
  for (const replacement of [
    entry,
    {
      ...entry,
      profile: {
        kind: 'proxy-chain' as const,
        settings: {
          tag: 'chain',
          steps: JSON.stringify({
            version: 1,
            steps: [
              { id: 'a', outbound: { type: 'node', nodeId: 'test-first' } },
              { id: 'b', outbound: { type: 'node', nodeId: 'test-second' } },
            ],
          }),
        },
      },
    },
    { ...entry, profile: { kind: 'policy-group' as const, settings: policy.data.settings } },
    entry,
  ]) {
    graph = applyStashedProfile(graph, replacement, { x: 0, y: 0 }, id);
    expect(graph.edges.find((e) => e.source === id && e.sourceHandle === 'observation')).toEqual({
      ...original,
      selected: false,
    });
    expect(() => compileRuntimeGraph(graph)).not.toThrow();
  }
});

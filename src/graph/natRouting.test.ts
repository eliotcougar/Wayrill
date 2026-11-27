import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { factoryDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { tableSettings, type TableRule } from './rules';
import { NAT_ROUTING_TAG } from './tun';
import type { GraphState } from './types';

const edge = (source: string, sourceHandle: string, target: string) => ({
  id: source + sourceHandle + target,
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});
function fixture(separate = true): GraphState {
  const tun = makeNode('tun-inbound', { x: 0, y: 0 }, 'tun');
  tun.data.settings.separateNatTraffic = separate;
  const direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
  const block = makeNode('block-outbound', { x: 400, y: 200 }, 'block');
  return {
    name: 'NAT',
    defaults: factoryDefaults(),
    nodes: [tun, direct, block],
    edges: [
      edge('tun', 'traffic', 'block'),
      ...(separate ? [edge('tun', 'nat-data', 'direct')] : []),
    ],
  };
}
function rules(g: GraphState) {
  return (compileRuntimeGraph(g).config.routing as { rules: Record<string, unknown>[] }).rules;
}
const row: TableRule = {
  id: 'source',
  name: 'Guest',
  enabled: true,
  matchAll: false,
  output: 'chosen',
  targetMatch: 'all',
  conditions: { sourceIP: '172.30.0.0/16', sourcePort: '53000', domain: 'domain:example.com' },
};
it('preserves guest source conditions, ordered rules and fallback', () => {
  const g = fixture(),
    filter = makeNode('routing-filter', { x: 200, y: 200 }, 'filter');
  filter.data.settings = {
    ...filter.data.settings,
    ...tableSettings({
      outputs: [
        { id: 'chosen', name: 'Guest' },
        { id: 'fallback', name: 'Other' },
      ],
      defaultOutput: 'fallback',
      rules: [row],
    }),
  };
  g.nodes.push(filter);
  g.edges = g.edges.filter((e) => e.sourceHandle !== 'nat-data');
  g.edges.push(
    edge('tun', 'nat-data', 'filter'),
    edge('filter', 'chosen', 'direct'),
    edge('filter', 'fallback', 'block'),
  );
  const selected = rules(g).filter(
    (r) => JSON.stringify(r.inboundTag) === JSON.stringify([NAT_ROUTING_TAG]),
  );
  expect(selected[0]).toMatchObject({
    sourceIP: ['172.30.0.0/16'],
    sourcePort: '53000',
    domain: ['domain:example.com'],
    outboundTag: 'direct',
  });
  expect(selected[1]).toMatchObject({ outboundTag: 'block' });
});

it('warns about application conditions only on a dedicated NAT path', () => {
  const g = fixture(false);
  const filter = makeNode('routing-filter', { x: 200, y: 200 }, 'filter');
  Object.assign(
    filter.data.settings,
    tableSettings({
      outputs: [
        { id: 'chosen', name: 'Application' },
        { id: 'fallback', name: 'Other' },
      ],
      defaultOutput: 'fallback',
      rules: [
        {
          ...row,
          name: 'Specific app',
          conditions: {},
          applications: [
            {
              kind: 'process',
              value: 'launcher.exe',
              mode: 'name',
              children: true,
              enabled: true,
            },
          ],
        },
      ],
    }),
  );
  g.nodes.push(filter);
  g.edges = [
    edge('tun', 'traffic', 'filter'),
    edge('filter', 'chosen', 'direct'),
    edge('filter', 'fallback', 'block'),
  ];

  const shared = compileRuntimeGraph(g);
  expect(shared.warnings.join('\n')).not.toContain('do not match Windows NAT traffic');
  expect(shared.config.routing).toMatchObject({
    rules: expect.arrayContaining([
      expect.objectContaining({ inboundTag: [NAT_ROUTING_TAG], outboundTag: 'block' }),
    ]),
  });

  g.nodes[0].data.settings.separateNatTraffic = true;
  g.edges.push(edge('tun', 'nat-data', 'filter'));
  expect(compileRuntimeGraph(g).warnings.join('\n')).toContain(
    'Specific app — host application and account conditions do not match Windows NAT traffic.',
  );
});

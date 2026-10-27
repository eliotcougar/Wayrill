import { makeNode } from './catalog';
import { createPolicyExample } from './policyExample';
import { tableSettings, type TableRule } from './rules';

export function createChainedExample() {
  const graph = createPolicyExample();
  graph.name = 'Chained filters · shared policy branch';
  const root = makeNode('routing-filter', { x: 352, y: 32 }, 'entry-filter'),
    shared = makeNode('routing-filter', { x: 680, y: 32 }, 'shared-filter');
  root.data.label = 'Application routes';
  shared.data.label = 'Shared destination rules';
  const rule = (id: string, conditions: Record<string, string>, output: string): TableRule => ({
    id: id.toLowerCase().replaceAll(' ', '-'),
    name: id,
    enabled: true,
    matchAll: false,
    output,
    conditions,
  });
  const outputs = [
    { id: 'shared', name: 'Inspect destination' },
    { id: 'blocked', name: 'Block' },
  ];
  Object.assign(
    root.data.settings,
    tableSettings({
      outputs,
      rules: [
        rule('Web', { port: '80,443' }, 'shared'),
        rule('Datagrams', { network: 'udp' }, 'shared'),
      ],
      defaultOutput: 'blocked',
    }),
  );
  Object.assign(
    shared.data.settings,
    tableSettings({
      outputs: [
        { id: 'group', name: 'Policy group' },
        { id: 'blocked', name: 'Block' },
      ],
      rules: [rule('Example domains', { domain: 'domain:example.net' }, 'group')],
      defaultOutput: 'blocked',
    }),
  );
  graph.nodes.push(root, shared);
  const positions: Record<string, { x: number; y: number }> = {
    'policy-input': { x: 16, y: 64 },
    'test-group': { x: 1008, y: 32 },
    'test-observatory': { x: 1008, y: 400 },
    'test-first': { x: 1344, y: 32 },
    'test-second': { x: 1344, y: 208 },
    'test-block': { x: 680, y: 440 },
  };
  for (const n of graph.nodes) if (positions[n.id]) n.position = positions[n.id];
  graph.edges.find((e) => e.source === 'policy-input' && e.sourceHandle === 'data')!.target =
    root.id;
  const wire = (source: string, sourceHandle: string, target: string) => ({
    id: `${source}-${sourceHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle: 'in',
  });
  graph.edges.push(
    wire(root.id, 'shared', shared.id),
    wire(root.id, 'blocked', 'test-block'),
    wire(shared.id, 'group', 'test-group'),
    wire(shared.id, 'blocked', 'test-block'),
  );
  return graph;
}

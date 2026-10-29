import { expect, it } from 'vitest';
import { makeNode, getOutputPorts } from './catalog';
import { factoryDefaults } from './defaults';
import { inboundPreview } from './inbounds';
import { compileRuntimeGraph } from './runtime';
import { diagnoseRuntimeGraph } from './diagnostics';
import { tableSettings } from './rules';
import type { GraphState } from './types';

const edge = (source: string, sourceHandle: string, target: string) => ({
  id: source + sourceHandle + target,
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});
function graph(): GraphState {
  return {
    name: 'TUN capture',
    defaults: factoryDefaults(),
    nodes: [
      makeNode('tun-inbound', { x: 0, y: 0 }, 'tun'),
      makeNode('direct-outbound', { x: 400, y: 0 }, 'direct'),
    ],
    edges: [edge('tun', 'traffic', 'direct')],
  };
}
it('new TUN captures both address families without a proxy or WinDivert input', () => {
  const g = graph();
  expect(getOutputPorts('tun-inbound')).toEqual(['traffic', 'dns']);
  expect(inboundPreview(g.nodes[0].data)).toMatchObject({
    protocol: 'tun',
    settings: {
      dns: ['1.1.1.1', '1.0.0.1'],
      autoSystemRoutingTable: ['0.0.0.0/1', '128.0.0.0/1', '::/1', '8000::/1'],
    },
  });
  const result = compileRuntimeGraph(g);
  expect(result.capture?.inputs).toEqual([
    expect.objectContaining({ source: 'tun', tag: 'tun-inbound', predicates: [], masks: ['0'] }),
  ]);
  expect(result.warnings).toEqual([]);
  expect(result.config.routing).toMatchObject({
    rules: expect.arrayContaining([
      { type: 'field', inboundTag: ['tun-inbound'], outboundTag: 'direct' },
    ]),
  });
});
it.each(['package', 'service', 'children'] as const)(
  'preserves %s matching through TUN application metadata',
  (kind) => {
    const g = graph(),
      filter = makeNode('routing-filter', { x: 250, y: 0 }, 'routes');
    filter.data.settings = {
      ...filter.data.settings,
      ...tableSettings({
        outputs: [{ id: 'default', name: 'Default' }],
        defaultOutput: 'default',
        rules: [
          {
            id: 'application-rule',
            name: 'Specific app',
            enabled: true,
            matchAll: false,
            output: 'default',
            targetMatch: 'all',
            conditions: { domain: 'full:example.com' },
            applications: [
              {
                kind: kind === 'children' ? 'process' : kind,
                value: 'example',
                enabled: true,
                mode: 'name',
                children: kind === 'children',
              },
            ],
          },
        ],
      }),
    };
    g.nodes.push(filter);
    g.edges = [edge('tun', 'traffic', 'routes'), edge('routes', 'default', 'direct')];
    const result = compileRuntimeGraph(g);
    expect(result.capture?.inputs[0]).toMatchObject({
      source: 'tun',
      predicates: [
        [
          expect.objectContaining({
            kind: kind === 'children' ? 'process' : kind,
            children: kind === 'children',
          }),
        ],
      ],
    });
    expect(result.config.routing).toMatchObject({
      rules: expect.arrayContaining([
        expect.objectContaining({
          domain: ['full:example.com'],
          user: [expect.stringContaining('regexp:^wr-')],
        }),
      ]),
    });
    expect(diagnoseRuntimeGraph(g).filter((i) => i.severity === 'error')).toEqual([]);
  },
);

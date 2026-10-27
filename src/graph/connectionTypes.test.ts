import { describe, expect, it } from 'vitest';
import { catalog, getOutputPorts, makeNode } from './catalog';
import {
  connectionTypes,
  sourceConnectionKind,
  targetConnectionKinds,
  typedConnectionProblem,
} from './connectionTypes';
import { connectionProblem, structureProblems } from './structure';
import { createTrafficExample, createVerificationExample } from './example';
import { createPolicyExample } from './policyExample';
import { compileRuntimeGraph } from './runtime';
import { isExecutableOutboundKind } from './outbounds';
import type { NodeKind } from './types';

const data = (kind: NodeKind) => makeNode(kind, { x: 0, y: 0 }).data;
describe('connection roles and compatibility', () => {
  it.each([
    ['proxy-inbound', 'data', 'traffic'],
    ['proxy-inbound', 'dns', 'dns-traffic'],
    ['dns-handler', 'resolver', 'resolver'],
    ['dns-handler', 'forward', 'dns-traffic'],
    ['dns-routing-filter', 'custom', 'resolver'],
    ['dns-servers', 'queries', 'dns-traffic'],
    ['xray-dns', 'custom', 'resolver'],
    ['xray-dns-servers', 'queries', 'dns-traffic'],
    ['policy-group', 'observation', 'observation'],
    ['routing-filter', 'dns', 'traffic'],
    ['routing-filter', 'observation', 'traffic'],
    ['routing-filter', 'resolver', 'traffic'],
  ] as const)('classifies %s/%s by its node role', (kind, port, expected) => {
    expect(sourceConnectionKind(data(kind), port)).toBe(expected);
  });
  it('classifies every registered output port, including arbitrary named rule outputs', () => {
    for (const definition of catalog) {
      const node = data(definition.kind);
      for (const port of getOutputPorts(definition.kind, node))
        expect(connectionTypes[sourceConnectionKind(node, port)]).toBeDefined();
    }
  });
  it('lets every executable outbound accept both traffic families ', () => {
    for (const definition of catalog.filter(
      (d) => isExecutableOutboundKind(d.kind) || d.kind === 'xray-outbound',
    )) {
      const target = data(definition.kind);
      expect(targetConnectionKinds(target)).toEqual(['traffic', 'dns-traffic']);
      expect(typedConnectionProblem(data('proxy-inbound'), 'dns', target)).toBeNull();
      expect(typedConnectionProblem(data('policy-group'), 'observation', target)).toMatch(
        /Observation/,
      );
    }
  });
  it('allows DNS traffic to enter traffic filters and groups instead of requiring identical colors', () => {
    for (const target of ['routing-filter', 'policy-group', 'dns-handler'] as const)
      expect(typedConnectionProblem(data('proxy-inbound'), 'dns', data(target))).toBeNull();
  });
  it('keeps resolver-selection and observatory links out of traffic inputs', () => {
    expect(
      typedConnectionProblem(data('dns-handler'), 'resolver', data('direct-outbound')),
    ).toMatch(/resolver path/);
    expect(typedConnectionProblem(data('routing-filter'), 'custom', data('dns-servers'))).toMatch(
      /resolver-selection/,
    );
    expect(
      typedConnectionProblem(data('policy-group'), 'observation', data('direct-outbound')),
    ).toMatch(/Observation/);
    expect(typedConnectionProblem(data('proxy-inbound'), 'data', data('observatory'))).toMatch(
      /observation/,
    );
    expect(
      typedConnectionProblem(data('policy-group'), 'observation', data('policy-group')),
    ).toMatch(/Observation/);
  });
  it('keeps authored and native DNS resolver graphs compatible with their own compilers', () => {
    expect(
      typedConnectionProblem(data('dns-handler'), 'resolver', data('dns-routing-filter')),
    ).toBeNull();
    expect(
      typedConnectionProblem(data('dns-routing-filter'), 'custom', data('dns-servers')),
    ).toBeNull();
    expect(typedConnectionProblem(data('xray-dns'), 'custom', data('xray-dns-servers'))).toBeNull();
    expect(typedConnectionProblem(data('xray-dns'), 'custom', data('dns-servers'))).toMatch(
      /compatible/,
    );
    expect(
      typedConnectionProblem(data('dns-handler'), 'resolver', data('xray-dns-servers')),
    ).toMatch(/compatible/);
    expect(
      typedConnectionProblem(data('xray-dns-servers'), 'queries', data('routing-filter')),
    ).toBeNull();
    expect(
      typedConnectionProblem(data('xray-dns-servers'), 'queries', data('direct-outbound')),
    ).toMatch(/global routing filter/);
    expect(typedConnectionProblem(data('dns-servers'), 'queries', data('routing-filter'))).toMatch(
      /configured Direct/,
    );
  });
  it('rejects incompatible native resolver connections during editing and structural validation', () => {
    const source = makeNode('xray-dns', { x: 0, y: 0 }, 'dns');
    source.data.settings.outputs = JSON.stringify([{ id: 'resolver', name: 'Resolver' }]);
    const target = makeNode('direct-outbound', { x: 0, y: 0 }, 'direct');
    const edge = {
      id: 'bad',
      source: source.id,
      sourceHandle: 'resolver',
      target: target.id,
      targetHandle: 'in',
    };
    const graph = { name: 'Fixture', nodes: [source, target], edges: [] };
    expect(connectionProblem(graph, edge)).toMatch(/resolver path/);
    expect(structureProblems({ ...graph, edges: [edge] })).toContainEqual(
      expect.objectContaining({ nodeId: 'dns', message: expect.stringMatching(/resolver path/) }),
    );
  });
  it('preserves all existing traffic and policy example connections and compiled configurations', () => {
    for (const graph of [
      createTrafficExample(),
      createPolicyExample('leastPing'),
      createVerificationExample(),
    ]) {
      expect(structureProblems(graph)).toEqual([]);
      const before = JSON.stringify(compileRuntimeGraph(graph).config);
      for (const e of graph.edges)
        expect(
          connectionProblem(
            { ...graph, edges: graph.edges.filter((other) => other.id !== e.id) },
            e,
          ),
        ).toBeNull();
      expect(JSON.stringify(compileRuntimeGraph(graph).config)).toBe(before);
    }
  });
  it('includes every role in the complete policy/DNS verification graph', () => {
    const graph = createVerificationExample();
    expect(
      new Set(
        graph.edges.map((edge) =>
          sourceConnectionKind(
            graph.nodes.find((node) => node.id === edge.source)!.data,
            edge.sourceHandle!,
          ),
        ),
      ),
    ).toEqual(new Set(Object.keys(connectionTypes)));
    expect(compileRuntimeGraph(graph).config).toMatchObject({
      routing: {
        balancers: [
          { tag: 'verification-policy', fallbackTag: 'block', strategy: { type: 'leastPing' } },
        ],
      },
      observatory: { subjectSelector: ['preferred', 'direct'], probeURL: 'https://example.com/' },
    });
  });
});

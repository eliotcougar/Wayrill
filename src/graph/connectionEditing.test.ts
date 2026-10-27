import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { createVerificationExample } from './example';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import {
  endpointDetail,
  applyConnectionEdit,
  connectionDescription,
  connectionEditProblem,
  connectionIsEditable,
  connectionSources,
} from './connectionEditing';
import type { GraphState } from './types';

const link = (source: string, sourceHandle: string, target: string) => ({
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});

describe('connection edits', () => {
  it('replaces endpoints atomically, preserves identity and metadata, and selects the edited wire', () => {
    const graph = createVerificationExample(),
      old = graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
    old.data = { marker: 'keep' };
    const next = applyConnectionEdit(
      graph,
      link('socks', 'data', 'block'),
      'ignored-new-id',
      old.id,
    );
    expect(next.edges).toHaveLength(graph.edges.length);
    expect(next.edges.find((e) => e.id === old.id)).toMatchObject({
      ...link('socks', 'data', 'block'),
      data: { marker: 'keep' },
      selected: true,
    });
    expect(next.nodes.some((n) => n.selected)).toBe(false);
    expect(next.edges.filter((e) => e.selected)).toHaveLength(1);
    expect(graph.edges.find((e) => e.id === old.id)?.target).toBe('routes');
  });
  it('retains an unchanged graph without a history transaction', () => {
    const graph = createVerificationExample(),
      old = graph.edges[0];
    expect(
      applyConnectionEdit(
        graph,
        { ...old, sourceHandle: old.sourceHandle ?? null, targetHandle: old.targetHandle ?? null },
        old.id,
        old.id,
      ),
    ).toBe(graph);
  });
  it('does not replace an occupied source when adding or moving another wire onto it', () => {
    const graph = createVerificationExample(),
      old = graph.edges.find((e) => e.source === 'http' && e.sourceHandle === 'data')!;
    const draft = link('socks', 'data', 'direct');
    expect(connectionEditProblem(graph, draft)).toContain('already has a path');
    expect(connectionEditProblem(graph, draft, old.id)).toContain('already has a path');
    expect(applyConnectionEdit(graph, draft, 'new', old.id)).toBe(graph);
  });
  it('guards stale edges, removed nodes and dynamic output ports', () => {
    const graph = createVerificationExample(),
      old = graph.edges.find((e) => e.source === 'routes')!;
    expect(connectionEditProblem(graph, link('socks', 'data', 'block'), 'deleted-edge')).toContain(
      'no longer exists',
    );
    expect(
      connectionEditProblem(graph, link('routes', 'deleted-output', 'block'), old.id),
    ).toContain('output port');
    expect(
      connectionEditProblem(graph, link('routes', old.sourceHandle!, 'deleted-node'), old.id),
    ).toContain('missing node');
    expect(
      applyConnectionEdit(graph, link('routes', 'deleted-output', 'block'), old.id, old.id),
    ).toBe(graph);
  });
  it('rejects cycles introduced by reconnecting either endpoint', () => {
    const a = makeNode('routing-filter', { x: 0, y: 0 }, 'a'),
      b = makeNode('routing-filter', { x: 1, y: 0 }, 'b'),
      c = makeNode('direct-outbound', { x: 2, y: 0 }, 'c');
    const aPort = JSON.parse(String(a.data.settings.outputs))[0].id,
      bPort = JSON.parse(String(b.data.settings.outputs))[0].id;
    const graph: GraphState = {
      name: 'cycle fixture',
      nodes: [a, b, c],
      edges: [
        { id: 'ab', ...link('a', aPort, 'b') },
        { id: 'bc', ...link('b', bPort, 'c') },
      ],
    };
    expect(connectionEditProblem(graph, link('b', bPort, 'a'), 'bc')).toContain('routing loop');
    expect(applyConnectionEdit(graph, link('b', bPort, 'a'), 'bc', 'bc')).toBe(graph);
  });
  it('keeps source port identity separate from its human label', () => {
    const graph = createVerificationExample(),
      edge = graph.edges.find((e) => e.source === 'routes')!;
    expect(connectionDescription(graph, edge)).toContain('Traffic rules / ');
    expect(connectionDescription(graph, edge)).toContain('/ Input');
    const unknown = { ...edge, source: 'missing', target: 'missing' };
    expect(connectionDescription(graph, unknown)).toContain('Missing source');
    expect(connectionDescription(graph, unknown)).toContain('Missing destination');
  });
  it('protects generated native DNS paths from edits and manual recreation without changing the exported config', () => {
    const graph = importXrayConfig(
      JSON.stringify({
        dns: { servers: ['1.1.1.1'] },
        outbounds: [{ tag: 'direct', protocol: 'freedom' }],
      }),
    );
    const old = graph.edges.find(
      (edge) => graph.nodes.find((n) => n.id === edge.source)?.data.kind === 'xray-dns-servers',
    )!;
    const before = compileXrayGraph(graph).config;
    expect(old).toBeDefined();
    expect(connectionIsEditable(graph, old)).toBe(false);
    expect(connectionSources(graph).some((node) => node.id === old.source)).toBe(false);
    const draft = {
      ...old,
      sourceHandle: old.sourceHandle ?? null,
      targetHandle: old.targetHandle ?? null,
    };
    expect(connectionEditProblem(graph, draft, old.id)).toContain('generated');
    expect(connectionEditProblem({ ...graph, edges: [] }, draft)).toContain('automatically');
    expect(applyConnectionEdit(graph, draft, old.id, old.id)).toBe(graph);
    expect(compileXrayGraph(graph).config).toEqual(before);
  });
  it.each([
    ['proxy-inbound', 'data', 'direct-outbound', true],
    ['proxy-inbound', 'dns', 'policy-group', true],
    ['dns-handler', 'resolver', 'dns-servers', true],
    ['dns-handler', 'resolver', 'direct-outbound', false],
    ['policy-group', 'observation', 'observatory', true],
    ['policy-group', 'observation', 'direct-outbound', false],
    ['proxy-inbound', 'dns', 'observatory', false],
  ] as const)(
    'uses the same compatibility rules for %s / %s → %s',
    (sourceKind, port, targetKind, valid) => {
      const graph: GraphState = {
        name: 'typed fixture',
        nodes: [
          makeNode(sourceKind, { x: 0, y: 0 }, 'a'),
          makeNode(targetKind, { x: 1, y: 0 }, 'b'),
        ],
        edges: [],
      };
      expect(connectionEditProblem(graph, link('a', port, 'b')) === null).toBe(valid);
      expect(applyConnectionEdit(graph, link('a', port, 'b'), 'link').edges.length).toBe(
        valid ? 1 : 0,
      );
    },
  );
});

it('uses short identifiers only when otherwise identical connection endpoints collide', () => {
  const first = makeNode('routing-filter', { x: 0, y: 0 }, 'first-12345678'),
    second = makeNode('routing-filter', { x: 500, y: 0 }, 'second-87654321');
  const graph = createVerificationExample();
  graph.nodes = [first];
  expect(endpointDetail(first, graph)).not.toContain('ID ');
  graph.nodes.push(second);
  expect(endpointDetail(first, graph)).toContain('ID 12345678');
  expect(endpointDetail(second, graph)).toContain('ID 87654321');
  second.data.label = 'Distinct rules';
  expect(endpointDetail(first, graph)).not.toContain('ID ');
});

// @vitest-environment node
import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { bundledExamples, createProxyStarter } from '../graph/examples';
import { parseGraph, serializeGraph } from '../graph/model';
import { analyzeGraph } from '../graph/analysis';
import { capturePlaceholder } from '../graph/inboundPlaceholder';
import { subscriptionEngine } from '../profiles/serviceEngine';
import { newPoolStash, openGraphLayer } from './graphLayer';
import { capturePoolBundle, capturePoolGraph, preparePoolWorkspace } from './model';

const recipient = 'abcdef0123456789abcdef0123456789';
const stash = newPoolStash();

it('previews and resolves two named placeholders without exposing or changing inbound settings', () => {
  const admin = createProxyStarter();
  admin.nodes[0].data.settings.password = 'admin-only';
  admin.nodes[0].data.settings.auth = 'password';
  const other = makeNode('proxy-inbound', { x: 0, y: 400 }, 'admin-extra');
  const block = makeNode('block-outbound', { x: 600, y: 400 }, 'block');
  admin.nodes.push(other, block);
  admin.edges.push({
    id: 'to-block',
    source: other.id,
    sourceHandle: 'data',
    target: block.id,
    targetHandle: 'in',
  });
  const bundle = capturePoolGraph('Pool', admin, stash, [], [admin.nodes[0].id, other.id]);
  expect(bundle.version).toBe(3);
  expect(bundle.graph).not.toContain('admin-only');
  expect(analyzeGraph(parseGraph(bundle.graph)).issues[0].message).toContain(
    'Assign local inbounds',
  );

  const local = createProxyStarter();
  const second = makeNode('proxy-inbound', { x: 0, y: 500 }, 'second-device-input');
  second.data.settings.port = 10819;
  second.data.settings.tag = 'local-second';
  local.nodes.push(second);
  const bindings = { [local.nodes[0].id]: admin.nodes[0].id, [second.id]: other.id };
  const preview = subscriptionEngine({
    operation: 'poolInspect',
    bundle,
    capture: 'current',
    appliedGraph: serializeGraph(local),
    stash: '',
  });
  expect(preview.poolEntries).toMatchObject({
    placeholders: expect.arrayContaining([
      { id: other.id, name: other.data.label, ports: ['data'], destination: 'Block' },
    ]),
    inbounds: expect.arrayContaining([
      expect.objectContaining({
        id: second.id,
        name: second.data.label,
        kind: 'Proxy inbound',
        enabled: true,
      }),
    ]),
  });
  const result = preparePoolWorkspace(bundle, local, stash, recipient, 'current', bindings);
  expect(result.graph.nodes.find((node) => node.id === second.id)?.data.settings.port).toBe(10819);
  expect(result.graph.edges.find((edge) => edge.source === second.id)?.target).toBe(block.id);
  expect(result.graph.nodes.some((node) => node.data.kind === 'inbound-placeholder')).toBe(false);

  const revised = parseGraph(bundle.graph);
  revised.nodes.find((node) => node.id === other.id)!.data.label = 'Renamed placeholder';
  const updated = capturePoolGraph('Update', revised, stash, []);
  const next = preparePoolWorkspace(updated, result.graph, stash, recipient, 'current', bindings);
  expect(next.graph.edges.find((edge) => edge.source === second.id)?.target).toBe(block.id);
  revised.nodes = revised.nodes.filter((node) => node.id !== other.id);
  revised.edges = revised.edges.filter((edge) => edge.source !== other.id);
  const removed = capturePoolGraph('Update', revised, stash, []);
  expect(() =>
    preparePoolWorkspace(removed, result.graph, stash, recipient, 'current', bindings),
  ).toThrow('Edit inbound assignments');
});

it('keeps TUN DNS and ICS traffic on their assigned paths', () => {
  const graph = bundledExamples.find((item) => item.id === 'tun')!.create();
  const tun = graph.nodes.find((node) => node.data.kind === 'tun-inbound')!;
  const ics = makeNode('ics-tun', { x: 0, y: 500 }, 'share-entry');
  const block = makeNode('block-outbound', { x: 600, y: 500 }, 'share-exit');
  graph.nodes.push(ics, block);
  graph.edges.push({
    id: 'share-route',
    source: ics.id,
    sourceHandle: 'traffic',
    target: block.id,
    targetHandle: 'in',
  });
  const bundle = capturePoolGraph('Pool', graph, stash, [], [tun.id, ics.id]);
  const result = preparePoolWorkspace(bundle, graph, stash, recipient, 'current', {
    [tun.id]: tun.id,
    [ics.id]: ics.id,
  });
  const paths = (source: typeof graph) =>
    source.edges
      .filter((edge) => edge.source === tun.id || edge.source === ics.id)
      .map(({ source, sourceHandle, target }) => ({ source, sourceHandle, target }));
  expect(paths(result.graph)).toEqual(paths(graph));
});

it('keeps legacy subscribers working when an administrator first saves the placeholder graph', () => {
  const graph = createProxyStarter();
  const legacy = capturePoolBundle('Pool', graph, stash, [], graph.nodes[0].id);
  const old = preparePoolWorkspace(legacy, undefined, stash, recipient, 'proxy');
  const draft = openGraphLayer(legacy).graph;
  const migrated = capturePoolGraph('Pool', draft, stash, []);
  expect(
    preparePoolWorkspace(migrated, old.graph, stash, recipient, 'current').graph.edges,
  ).toEqual(old.graph.edges);
  expect(preparePoolWorkspace(migrated, undefined, stash, recipient, 'proxy').bindings).toEqual({
    proxy: 'pool-proxy-capture',
  });
});

it('requires dedicated slots and preserves separate paths on enrollment and refresh', () => {
  const { graph } = openGraphLayer();
  const tun = graph.nodes.find((node) => capturePlaceholder(node.data) === 'tun')!;
  const filter = makeNode('routing-filter', { x: 320, y: 300 }, 'tun-rules');
  graph.nodes.push(filter);
  graph.edges.find((edge) => edge.source === tun.id && edge.sourceHandle === 'data')!.target =
    filter.id;
  graph.edges.push({
    id: 'tun-exit',
    source: filter.id,
    sourceHandle: 'default',
    target: 'direct',
    targetHandle: 'in',
  });
  const bundle = capturePoolGraph('Both modes', graph, stash, []);
  const both = preparePoolWorkspace(bundle, undefined, stash, recipient, 'both');
  expect(
    both.graph.edges.find((edge) => edge.source === 'proxy' && edge.sourceHandle === 'data')
      ?.target,
  ).toBe('direct');
  expect(
    both.graph.edges.find((edge) => edge.source === 'capture' && edge.sourceHandle === 'traffic')
      ?.target,
  ).toBe(filter.id);
  expect(
    preparePoolWorkspace(bundle, both.graph, stash, recipient, 'current', both.bindings).graph
      .edges,
  ).toEqual(both.graph.edges);
  expect(analyzeGraph(both.graph).issues.filter(({ severity }) => severity === 'error')).toEqual(
    [],
  );
  expect(() =>
    preparePoolWorkspace(bundle, undefined, stash, recipient, 'proxy', { proxy: tun.id }),
  ).toThrow('Edit inbound assignments');
  graph.nodes = graph.nodes.filter((node) => node.id !== tun.id);
  graph.edges = graph.edges.filter((edge) => edge.source !== tun.id);
  expect(() => capturePoolGraph('Missing TUN', graph, stash, [])).toThrow('one Proxy and one TUN');
});

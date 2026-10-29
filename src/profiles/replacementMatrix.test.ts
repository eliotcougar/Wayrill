import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeNode } from '../graph/catalog';
import { preparedEntry } from '../graph/composites';
import { createPolicyExample } from '../graph/policyExample';
import { policyProfile, emptyPolicySources } from '../graph/policySources';
import { analyzeGraph } from '../graph/analysis';
import { compileRuntimeGraph } from '../graph/runtime';
import { parseGraph, serializeGraph } from '../graph/model';
import { applyStashedProfile } from './graph';
import { importProfiles, serializeStash, type StashEntry } from './import';
import { subscriptionEngine } from './serviceEngine';
import { runtimeFixture } from './subscriptionRuntime.fixture';

const { graph, stash } = runtimeFixture();
const plain = stash.groups[0].entries[0];
const second = importProfiles('socks://192.0.2.2:2080#Second hop').groups[0].entries[0];
const policyGraph = createPolicyExample('leastPing');
const policy = preparedEntry(policyGraph, 'test-group');
const block = preparedEntry(policyGraph, 'test-block');
function chainEntry(exit: StashEntry, id: string) {
  const chain = makeNode('proxy-chain', { x: 0, y: 0 }, id);
  chain.data.settings.steps = JSON.stringify({
    version: 1,
    steps: [
      { id: 'first', outbound: policyProfile(plain) },
      { id: 'last', outbound: policyProfile(exit) },
    ],
  });
  const observer = policyGraph.nodes.find((node) => node.data.kind === 'observatory')!;
  return preparedEntry(
    {
      ...graph,
      nodes: [...graph.nodes, chain, observer],
      edges: [
        ...graph.edges,
        {
          id: id + '-observation',
          source: chain.id,
          sourceHandle: 'observation',
          target: observer.id,
          targetHandle: 'in',
        },
      ],
    },
    chain.id,
  );
}
const chain = chainEntry(second, 'ordinary-chain');
const chainPolicy = chainEntry(policy, 'chain-with-policy');
const policyChain: StashEntry = {
  ...policy,
  id: 'policy-with-chain',
  profile: {
    ...policy.profile!,
    settings: {
      ...policy.profile!.settings,
      sources: JSON.stringify({
        ...emptyPolicySources(),
        manual: [policyProfile(chain)],
        fallback: policyProfile(block),
      }),
    },
  },
};
const definitions = { plain, policy, chain, chainPolicy, policyChain };
const core = process.env.WAYRILL_XRAY_TEST_EXE;
const directory = process.env.WAYRILL_XRAY_FIXTURE_DIR;
// Each shape is exercised as both an existing route and its replacement.
// Nested shapes cover policy-in-chain and chain-in-policy dependencies.
for (const [from, to] of [
  ['plain', 'policy'],
  ['policy', 'chain'],
  ['chain', 'policyChain'],
  ['policyChain', 'chainPolicy'],
  ['chainPolicy', 'plain'],
] as const) {
  const original = definitions[from],
    replacement = definitions[to];
  const label = from + ' → ' + to;
  function candidate() {
    const old = applyStashedProfile(graph, original, { x: 0, y: 0 }, 'proxy');
    const result = subscriptionEngine({
      operation: 'runtime',
      stash: serializeStash({
        ...stash,
        groups: [{ ...stash.groups[0], entries: [replacement] }],
      }),
      appliedGraph: serializeGraph(old),
      replacement: { nodeId: 'proxy', groupId: stash.groups[0].id, entryId: replacement.id },
    });
    if (!('graph' in result)) throw new Error('Missing prepared runtime');
    return parseGraph(result.graph!);
  }
  it(label + ' preserves incoming routes and survives graph serialization', () => {
    const next = candidate();
    const analysis = analyzeGraph(next);
    expect(analysis.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(next.edges.filter((edge) => edge.target === 'proxy')).toEqual(
      parseGraph(serializeGraph(graph)).edges.filter((edge) => edge.target === 'proxy'),
    );
    expect(next.nodes.find((node) => node.id === 'proxy')!.data.settings.tag).toBe('proxy');
    expect(compileRuntimeGraph(parseGraph(serializeGraph(next)))).toEqual(analysis.compilation);
  });
  it(label + ' preserves TUN and WinDivert capture scope', () => {
    for (const kind of ['tun-inbound', 'windivert-inbound'] as const) {
      const captured = (g: typeof graph) => ({
        ...g,
        nodes: g.nodes.map((node) =>
          node.id === 'input' ? makeNode(kind, node.position, node.id) : node,
        ),
        edges: g.edges.map((edge) =>
          edge.source === 'input' && edge.sourceHandle === 'data' && kind === 'tun-inbound'
            ? { ...edge, sourceHandle: 'traffic' }
            : edge,
        ),
      });
      const before = compileRuntimeGraph(
        captured(applyStashedProfile(graph, original, { x: 0, y: 0 }, 'proxy')),
      );
      const after = compileRuntimeGraph(captured(candidate()));
      expect(before.capture).toBeDefined();
      expect(after.capture).toEqual(before.capture);
    }
  });
  it.skipIf(!core || !directory)(label + ' passes the pinned Xray configuration parser', () => {
    mkdirSync(directory!, { recursive: true });
    const file = join(directory!, 'replacement-' + from + '-' + to + '.json');
    writeFileSync(file, JSON.stringify(compileRuntimeGraph(candidate()).config));
    const result = spawnSync(core!, ['run', '-test', '-config', file], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}

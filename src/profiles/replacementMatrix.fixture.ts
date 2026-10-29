import { makeNode } from '../graph/catalog';
import { preparedEntry } from '../graph/composites';
import { parseGraph, serializeGraph } from '../graph/model';
import { createPolicyExample } from '../graph/policyExample';
import { emptyPolicySources, policyProfile } from '../graph/policySources';
import { applyStashedProfile } from './graph';
import { importProfiles, serializeStash, type StashEntry } from './import';
import { subscriptionEngine } from './serviceEngine';
import { runtimeFixture } from './subscriptionRuntime.fixture';

export const { graph, stash } = runtimeFixture();
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
export const replacementCases = (
  [
    ['plain', 'policy'],
    ['policy', 'chain'],
    ['chain', 'policyChain'],
    ['policyChain', 'chainPolicy'],
    ['chainPolicy', 'plain'],
  ] as const
).map(([from, to]) => {
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
    return parseGraph(result.graph);
  }
  return { label, original, candidate };
});

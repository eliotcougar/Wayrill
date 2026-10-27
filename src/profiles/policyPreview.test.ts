import { expect, it } from 'vitest';
import { calculatePolicyPreview } from './policyPreview';
import { createPolicyExample } from '../graph/policyExample';
import { editPolicyGraph } from '../graph/policies';
import { compilePolicies } from '../graph/policyCompilation';
import { isExecutableOutboundKind, outboundBundle } from '../graph/outbounds';
import {
  emptyPolicySources,
  subscriptionSource,
  refreshPolicySources,
  policySourceProblems,
  policyProfile,
  policyProfileId,
  cachePolicyPreview,
  readPolicySources,
  type PolicySources,
} from '../graph/policySources';
import { importProfiles, type Stash } from './import';
it('prepares the same compiled policy fragment as the ordinary graph compiler', () => {
  const graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!,
    observer = graph.nodes.find((n) => n.data.kind === 'observatory')!;
  const group = importProfiles('vless://public@a.example.net:443?security=tls#Public').groups[0],
    stash: Stash = {
      format: 'wayrill.stash',
      version: 3,

      groups: [group],
    };
  const sources: PolicySources = {
    ...emptyPolicySources(),
    subscriptions: [subscriptionSource(group)],
    manual: [policyProfile(group.entries[0])],
    fallback: { type: 'node', nodeId: 'test-block' },
  };
  const input = {
    settings: { ...node.data.settings, selection: 'combined' },
    sources,
    observer,
    corePreview: true,
  };
  const result = calculatePolicyPreview(graph, node, stash, input);
  expect(result.summary.entries).toHaveLength(1);
  expect(result.summary.duplicates).toBe(1);
  expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  const next = editPolicyGraph(
    graph,
    node.id,
    { ...input.settings, sources: result.serialized },
    observer.id,
    observer,
  );
  expect(JSON.parse(result.corePreview)).toEqual(
    compilePolicies(next, [
      { tag: 'wayrill-runtime-unmatched' },
      ...graph.nodes
        .filter((n) => isExecutableOutboundKind(n.data.kind))
        .flatMap((n) => outboundBundle(n.data)),
    ]),
  );
});
it('reuses unchanged snapshots, refreshes immutable replacements and retains missing snapshots', () => {
  const group = importProfiles('vless://public@a.example.net:443?security=tls#Public').groups[0],
    stash: Stash = {
      format: 'wayrill.stash',
      version: 3,

      groups: [group],
    };
  const sources = refreshPolicySources(
    { ...emptyPolicySources(), subscriptions: [subscriptionSource(group)] },
    stash,
  );
  expect(refreshPolicySources(sources, stash)).toBe(sources);
  const changed = refreshPolicySources(sources, {
    ...stash,
    groups: [{ ...group, entries: group.entries.map((e) => ({ ...e, name: 'Renamed' })) }],
  });
  expect(changed.subscriptions[0].entries[0].name).toBe('Renamed');
  expect(sources.subscriptions[0].entries[0].name).toBe('Public');
  const missing = refreshPolicySources(sources, { ...stash, groups: [] });
  expect(missing.subscriptions[0].entries).toBe(sources.subscriptions[0].entries);
  expect(missing.subscriptions[0].missing).toBe(true);
});
it('never lets cached validation conceal changed profile settings, identities, or defaults', () => {
  const graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  const entry = importProfiles('vless://public@a.example.net:443?security=tls#Public').groups[0]
      .entries[0],
    reference = policyProfile(entry);
  const sources = { ...emptyPolicySources(), manual: [reference] };
  node.data.settings.selection = 'manual';
  node.data.settings.fallbackEnabled = false;
  expect(policySourceProblems(graph, node, sources)).toEqual([]);
  reference.profile.settings.port = -1;
  expect(policySourceProblems(graph, node, sources).some((i) => i.severity === 'error')).toBe(true);
  reference.profile.settings.port = 443;
  reference.id = '00000000000000000000000000000000';
  expect(
    policySourceProblems(graph, node, sources).some((i) => i.message.includes('identity')),
  ).toBe(true);
  reference.id = policyProfileId(reference.profile);
  expect(policySourceProblems(graph, node, sources)).toEqual([]);
  graph.defaults!.settings.fingerprint = 'invalid-fingerprint';
  expect(policySourceProblems(graph, node, sources).some((i) => i.severity === 'error')).toBe(true);
});
it('adopts only the exact successfully prepared snapshot and keeps compiler validation available', () => {
  const graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!,
    observer = graph.nodes.find((n) => n.data.kind === 'observatory')!;
  const group = importProfiles('vless://public@a.example.net:443?security=tls#Public').groups[0],
    stash: Stash = {
      format: 'wayrill.stash',
      version: 3,

      groups: [group],
    };
  const input = {
    settings: { ...node.data.settings, selection: 'subscription' },
    sources: {
      ...emptyPolicySources(),
      subscriptions: [subscriptionSource(group)],
      fallback: { type: 'node' as const, nodeId: 'test-block' },
    },
    observer,
    corePreview: false,
  };
  const result = calculatePolicyPreview(graph, node, stash, input);
  expect(() => cachePolicyPreview(node.data, result.sources, result.serialized, stash)).toThrow(
    /does not match/,
  );
  node.data.settings = { ...input.settings, sources: result.serialized };
  cachePolicyPreview(node.data, result.sources, result.serialized, stash);
  expect(readPolicySources(node.data)).toBe(result.sources);
  expect(refreshPolicySources(result.sources, stash)).toBe(result.sources);
  expect(policySourceProblems(graph, node)).toEqual([]);
});

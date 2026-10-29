import { expect, it } from 'vitest';
import { createPolicyExample } from '../graph/policyExample';
import {
  emptyPolicySources,
  policySourceProblems,
  policyProfile,
  policyProfileId,
} from '../graph/policySources';
import { importProfiles } from './import';
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

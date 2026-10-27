import { expect, it } from 'vitest';
import { calculatePolicyPreview } from './policyPreview';
import { policyPreviewView } from './policyPreviewView';
import { createPolicyExample } from '../graph/policyExample';
import { emptyPolicySources, subscriptionSource } from '../graph/policySources';
import { importProfiles, type Stash } from './import';
it('returns bounded credential-free pages without changing membership or full commit snapshots', () => {
  const graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  const group = importProfiles(
    Array.from(
      { length: 80 },
      (_, i) => `socks://u:private-password@host-${i}.example:1080#Edge ${i}`,
    ).join('\n'),
  ).groups[0];
  const stash: Stash = { format: 'wayrill.stash', version: 3, groups: [group] };
  const result = calculatePolicyPreview(graph, node, stash, {
    settings: { ...node.data.settings, selection: 'subscription' },
    sources: { ...emptyPolicySources(), subscriptions: [subscriptionSource(group)] },
    observer: graph.nodes.find((n) => n.data.kind === 'observatory')!,
    corePreview: false,
  });
  const page = policyPreviewView(graph, result, { search: '', page: 1 });
  expect(page.summary).toMatchObject({ total: 80, matched: 80, page: 1 });
  expect(page.summary.rows).toHaveLength(25);
  expect(JSON.stringify(page)).not.toContain('private-password');
  expect(JSON.stringify(page)).not.toContain('serialized');
  const searched = policyPreviewView(graph, result, { search: 'host-79', page: 50 });
  expect(searched.summary).toMatchObject({ total: 80, matched: 1, page: 0 });
  expect(searched.summary.rows[0].summary.name).toBe('Edge 79');
  expect(result.sources.subscriptions[0].entries).toHaveLength(80);
});

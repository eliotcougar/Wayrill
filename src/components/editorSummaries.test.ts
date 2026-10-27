import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { createPolicyExample } from '../graph/policyExample';
import { emptyPolicyFilter, policyProfileId, readPolicySources } from '../graph/policySources';
import { policySetSummary, ruleConditionSummary, summarizeTerms } from './editorSummaries';
import type { TableRule } from '../graph/rules';
const rule: TableRule = {
  id: 'r',
  name: 'Test',
  enabled: true,
  output: 'out',
  matchAll: false,
  conditions: { domain: 'full:a.example\nfull:b.example', port: '443', network: 'tcp' },
};
it('makes condition families AND and list alternatives OR explicit', () => {
  expect(ruleConditionSummary(rule)).toBe(
    'Destination domains: full:a.example OR full:b.example AND Destination ports: 443 AND Network: tcp',
  );
});
it('labels catch-all and incomplete rows separately and bounds long list values', () => {
  expect(ruleConditionSummary({ ...rule, matchAll: true })).toBe('Match all traffic');
  expect(ruleConditionSummary({ ...rule, conditions: {} })).toContain('needs attention');
  expect(summarizeTerms('a\nb\nc\nd')).toBe('a OR b (+2)');
  expect(summarizeTerms('x'.repeat(10000)).length).toBeLessThan(70);
});

it('preserves native inverse-list wording instead of claiming each negation is an OR alternative', () => {
  const summary = ruleConditionSummary({
    ...rule,
    conditions: { ip: '!10.0.0.0/8\n!192.168.0.0/16' },
  });
  expect(summary).toBe('Destination IPs: !10.0.0.0/8 · !192.168.0.0/16 (native list)');
});
it('counts only active source modes and shows every contributing source after deduplication', () => {
  const graph = createPolicyExample(),
    group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  const sources = readPolicySources(group.data);
  const profile = { kind: 'direct-outbound' as const, settings: { redirect: '127.0.0.1:18881' } };
  const ref = {
    type: 'profile' as const,
    id: policyProfileId(profile),
    name: 'Public direct',
    profile,
  };
  sources.manual = [ref, { type: 'node', nodeId: 'test-first' }];
  sources.subscriptions = [
    {
      groupId: 's',
      name: 'Public subscription',
      filter: emptyPolicyFilter(),
      entries: [ref],
      updatedAt: null,
      rejected: 2,
      missing: false,
    },
  ];
  group.data.settings.sources = JSON.stringify(sources);
  group.data.settings.selection = 'combined';
  const preview = policySetSummary(graph, group);
  expect(preview).toMatchObject({ manual: 2, subscription: 1, duplicates: 1, rejected: 2 });
  expect(preview.entries).toHaveLength(2); // graph reference and copied profile remain separate
  expect(preview.entries[0].origins).toEqual(['Manual set', 'Public subscription']);
  group.data.settings.selection = 'manual';
  expect(policySetSummary(graph, group)).toMatchObject({
    manual: 2,
    subscription: 0,
    duplicates: 0,
    rejected: 0,
  });
  group.data.settings.selection = 'subscription';
  expect(policySetSummary(graph, group)).toMatchObject({
    manual: 0,
    subscription: 1,
    duplicates: 0,
    rejected: 2,
  });
});
it('preserves native prefix membership without including inactive sources', () => {
  const graph = createPolicyExample(),
    group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  group.data.settings.selection = 'prefixes';
  group.data.settings.selectorPrefixes = 'test-a';
  expect(policySetSummary(graph, group)).toMatchObject({
    manual: 0,
    subscription: 0,
    duplicates: 0,
    rejected: 0,
    entries: [
      { reference: { type: 'node', nodeId: 'test-first' }, origins: ['Native tag prefixes'] },
    ],
  });
  graph.nodes.push(makeNode('direct-outbound', { x: 0, y: 0 }, 'extra'));
  expect(policySetSummary(graph, group).entries).toHaveLength(1);
});

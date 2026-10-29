import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import {
  readRuleTable,
  tableSettings,
  routingRuleFields,
  ruleTableProblems,
  normalizeRuleLists,
  routingListEntries,
} from './rules';
import { ruleConditionSummary } from '../components/editorSummaries';
const rule = {
  id: 'qa',
  name: 'QA',
  enabled: true,
  output: 'default',
  matchAll: false,
  conditions: {
    domain:
      '  # Domains, comments survive\n domain : example.net,  \n full: other.net,\n regexp:^with space#[0-9]{1,3}$,',
    ip: '# LAN\n 192.168.0.0 / 16,\n geoip : private,',
  },
};
it('keeps comments/literal regexp content in drafts and strips formatting for core compilation', () => {
  expect(routingRuleFields(rule)).toEqual({
    domain: ['domain:example.net', 'full:other.net', 'regexp:^with space#[0-9]{1,3}$'],
    ip: ['192.168.0.0/16', 'geoip:private'],
  });
  const saved = normalizeRuleLists(rule);
  expect(saved.conditions.domain).toContain('# Domains, comments survive');
  expect(saved.conditions.domain).not.toContain('example.net,');
  expect(saved.conditions.domain).toContain('{1,3}');
  expect(rule.conditions.domain).toContain('example.net,');
  expect(ruleConditionSummary(rule)).not.toContain('# Domains');
  const n = makeNode('routing-filter', { x: 0, y: 0 }),
    t = readRuleTable(n.data.settings);
  n.data.settings = { ...n.data.settings, ...tableSettings({ ...t, rules: [rule] }) };
  expect(ruleTableProblems(n.data)).toEqual([]);
});
it('rejects comment-only routing instead of compiling an unconditional rule', () => {
  const n = makeNode('routing-filter', { x: 0, y: 0 }),
    t = readRuleTable(n.data.settings),
    empty = { ...rule, conditions: { domain: '  # notes\n\n', ip: '# notes' } };
  n.data.settings = { ...n.data.settings, ...tableSettings({ ...t, rules: [empty] }) };
  expect(
    ruleTableProblems(n.data).some(
      (i) => i.severity === 'error' && i.message.includes('add a condition'),
    ),
  ).toBe(true);
  expect(routingRuleFields(empty)).toEqual({});
  expect(routingListEntries('regexp:^foo#bar$\nkeyword:hello world', 'domain')).toEqual([
    'regexp:^foo#bar$',
    'keyword:hello world',
  ]);
});

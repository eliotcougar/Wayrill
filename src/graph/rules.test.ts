import { describe, expect, it } from 'vitest';
import { createRoutingExample } from './example';
import { readRuleTable, routingRuleFields, ruleTableProblems, tableSettings } from './rules';

describe('combined routing rule tables', () => {
  it('retains disabled drafts, diagnoses active invalid conditions and explains shadowing', () => {
    const node = createRoutingExample().nodes.find((item) => item.id === 'routes')!;
    const table = readRuleTable(node.data.settings);
    table.rules[0].conditions = { port: '80-1', ip: '999.1.1.1/33', attrs: '{' };
    table.rules[0].enabled = false;
    Object.assign(node.data.settings, tableSettings(table));
    expect(ruleTableProblems(node.data)).toEqual([]);
    table.rules[0].enabled = true;
    Object.assign(node.data.settings, tableSettings(table));
    expect(ruleTableProblems(node.data).filter((issue) => issue.severity === 'error')).toHaveLength(
      3,
    );
    table.rules[0].matchAll = true;
    Object.assign(node.data.settings, tableSettings(table));
    expect(ruleTableProblems(node.data)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('hides all later'),
      }),
    ]);
    expect(routingRuleFields(table.rules[0])).toEqual({ network: 'tcp,udp' });
  });
  it('requires explicit match-all instead of silently accepting an empty traffic rule', () => {
    const node = createRoutingExample().nodes.find((item) => item.id === 'routes')!;
    const table = readRuleTable(node.data.settings);
    table.rules[0].conditions = {};
    Object.assign(node.data.settings, tableSettings(table));
    expect(ruleTableProblems(node.data)[0].message).toContain('add a condition');
  });
});

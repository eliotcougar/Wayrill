import { expect, it } from 'vitest';
import { createTrafficExample } from './example';
import { coreResourceFailure } from './coreValidationDiagnostics';
import { readRuleTable, tableSettings } from './rules';

it('points a missing geosite group to the enabled rule that uses it', () => {
  const graph = createTrafficExample();
  const filter = graph.nodes.find((node) => node.data.kind === 'routing-filter')!;
  const table = readRuleTable(filter.data.settings);
  const rule = { ...table.rules[0], conditions: { domain: 'geosite:work' } };
  table.rules = [
    rule,
    { ...rule, id: 'inactive', enabled: false },
    { ...rule, id: 'other', conditions: { domain: 'geosite:games' } },
  ];
  Object.assign(filter.data.settings, tableSettings(table));
  const result = coreResourceFailure(graph, 'failed to load geosite:work');
  expect(result?.issues).toEqual([
    expect.objectContaining({ nodeId: filter.id, rowId: rule.id, fieldKey: 'domain' }),
  ]);
});

import { expect, it } from 'vitest';
import { createTrafficExample } from './example';
import { readRuleTable, tableSettings } from './rules';
import { coreResourceFailure } from './coreValidationDiagnostics';
it('maps a case-insensitive core missing-set error to its exact traffic rule', () => {
  const graph = createTrafficExample(),
    node = graph.nodes.find((n) => n.id === 'routes')!;
  const table = readRuleTable(node.data.settings);
  table.rules[0].conditions.domain = 'geosite:ru-available-only-inside';
  node.data.settings = { ...node.data.settings, ...tableSettings(table) };
  const result = coreResourceFailure(
    graph,
    'Xray rejected: failed to load geosite RU-AVAILABLE-ONLY-INSIDE > EOF',
  )!;
  expect(result.issues).toEqual([
    expect.objectContaining({ nodeId: node.id, rowId: table.rules[0].id, fieldKey: 'domain' }),
  ]);
  expect(result.message).toContain('Resource files');
});
it('does not label unrelated validation failures as resource errors', () => {
  expect(coreResourceFailure(createTrafficExample(), 'invalid TLS setting')).toBeNull();
});

import { describe, expect, it } from 'vitest';
import { getOutputPorts } from './catalog';
import { createRoutingExample } from './example';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  redoWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';
import { diagnoseGraph, parseGraph, serializeGraph, updateGraphNode } from './model';
import { readRuleTable, routingRuleFields, ruleTableProblems, tableSettings } from './rules';

describe('combined routing rule tables', () => {
  it('round-trips ordered rows, output identities, independent Data and DNS branches', () => {
    const graph = createRoutingExample();
    const restored = parseGraph(serializeGraph(graph));
    const filter = restored.nodes.find((node) => node.id === 'routes')!;
    expect(readRuleTable(filter.data.settings).rules.map((rule) => rule.name)).toEqual([
      'Blocked destinations',
      'Selected domains',
      'Local networks',
    ]);
    expect(getOutputPorts(filter.data.kind, filter.data)).toEqual([
      'blocked',
      'preferred',
      'default',
    ]);
    expect(diagnoseGraph(restored)).toEqual([]);
  });
  it('applies output removal and all affected connections as one undoable transaction', () => {
    const graph = createRoutingExample();
    const node = graph.nodes.find((item) => item.id === 'routes')!;
    const table = readRuleTable(node.data.settings);
    table.rules[0].output = 'default';
    table.outputs = table.outputs.filter((output) => output.id !== 'blocked');
    const updated = updateGraphNode(graph, node.id, {
      settings: { ...node.data.settings, ...tableSettings(table) },
    });
    expect(updated.edges.map((edge) => edge.id)).not.toContain('routes-block');
    expect(updated.edges).toHaveLength(4);
    expect(updated.edges.find((edge) => edge.id === 'dns-direct')).toEqual(
      graph.edges.find((edge) => edge.id === 'dns-direct'),
    );
    const history = commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: updated });
    expect(undoWorkspaceHistory(history).present.graph.edges).toEqual(graph.edges);
    expect(redoWorkspaceHistory(undoWorkspaceHistory(history)).present.graph).toEqual(updated);
  });
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

import { describe, expect, it } from 'vitest';
import { getOutputPorts, makeNode, portLabel } from './catalog';
import { createRoutingExample } from './example';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  redoWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';
import {
  connectionProblem,
  diagnoseGraph,
  parseGraph,
  serializeGraph,
  updateGraphNode,
} from './model';
import {
  readRuleTable,
  routingRuleFields,
  ruleTablePlan,
  ruleTableProblems,
  tableSettings,
} from './rules';

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
  it('renames and reorders output labels without changing existing connections', () => {
    const graph = createRoutingExample();
    const node = graph.nodes.find((item) => item.id === 'routes')!;
    const table = readRuleTable(node.data.settings);
    table.outputs[1].name = 'Remote route';
    table.outputs.reverse();
    const updated = updateGraphNode(graph, node.id, {
      settings: { ...node.data.settings, ...tableSettings(table) },
    });
    expect(updated.edges).toEqual(graph.edges);
    expect(portLabel('preferred', updated.nodes.find((item) => item.id === node.id)!.data)).toBe(
      'Remote route',
    );
    expect(parseGraph(serializeGraph(updated)).edges).toEqual(graph.edges);
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
  it('checks dynamic ports, rejects fan-out and retains cycle prevention', () => {
    const graph = createRoutingExample();
    expect(
      connectionProblem(graph, {
        source: 'routes',
        sourceHandle: 'unknown',
        target: 'direct',
        targetHandle: 'in',
      }),
    ).toMatch(/matching output/);
    expect(
      connectionProblem(graph, {
        source: 'routes',
        sourceHandle: 'preferred',
        target: 'direct',
        targetHandle: 'in',
      }),
    ).toMatch(/already has a path/);
    graph.edges = graph.edges.filter((edge) => edge.id !== 'routes-preferred');
    expect(
      connectionProblem(graph, {
        source: 'routes',
        sourceHandle: 'preferred',
        target: 'socks',
        targetHandle: 'in',
      }),
    ).toMatch(/input port/);
    expect(
      connectionProblem(graph, {
        source: 'socks',
        sourceHandle: 'dns',
        target: 'routes',
        targetHandle: 'in',
      }),
    ).toMatch(/already has a path/);
  });
  it('keeps first enabled match order and explicit fallback in the design plan', () => {
    const node = createRoutingExample().nodes.find((item) => item.id === 'routes')!;
    const table = readRuleTable(node.data.settings);
    table.rules[0].enabled = false;
    table.rules.reverse();
    Object.assign(node.data.settings, tableSettings(table));
    const plan = ruleTablePlan(node.data);
    expect(plan.rules.map((rule) => rule.name)).toEqual(['Local networks', 'Selected domains']);
    expect(plan.fallback).toEqual({ output: 'default' });
    expect(plan.rules[1].match).toEqual({ domain: ['domain:example.net'], network: 'tcp,udp' });
  });
  it('preserves AND fields, list entries and RE2 expressions without applying JS regex semantics', () => {
    const fields = routingRuleFields({
      id: 'a',
      name: 'Composite',
      enabled: true,
      output: 'preferred',
      matchAll: false,
      conditions: {
        domain: 'domain:example.net\nregexp:(?i)example',
        port: '443,1000-2000',
        sourceIP: '10.0.0.0/8',
        attrs: '{":method":"GET"}',
      },
    });
    expect(fields).toEqual({
      domain: ['domain:example.net', 'regexp:(?i)example'],
      port: '443,1000-2000',
      sourceIP: ['10.0.0.0/8'],
      attrs: { ':method': 'GET' },
    });
  });
  it('rejects duplicate output IDs and missing references in imported documents', () => {
    const graph = createRoutingExample();
    const node = graph.nodes.find((item) => item.id === 'routes')!;
    const table = readRuleTable(node.data.settings);
    table.outputs[1].id = table.outputs[0].id;
    Object.assign(node.data.settings, tableSettings(table));
    expect(() => parseGraph(serializeGraph(graph))).toThrow(/duplicate output/);
    table.outputs[1].id = 'preferred';
    table.rules[0].output = 'missing';
    Object.assign(node.data.settings, tableSettings(table));
    expect(() => parseGraph(serializeGraph(graph))).toThrow(/missing output/);
  });
  it('diagnoses blank and duplicate output names', () => {
    const node = makeNode('routing-filter', { x: 0, y: 0 });
    const table = readRuleTable(node.data.settings);
    table.outputs[0].name = ' default ';
    Object.assign(node.data.settings, tableSettings(table));
    expect(ruleTableProblems(node.data).some((issue) => /already used/.test(issue.message))).toBe(
      true,
    );
    table.outputs[0].name = '';
    Object.assign(node.data.settings, tableSettings(table));
    expect(
      ruleTableProblems(node.data).some((issue) => /every output a name/.test(issue.message)),
    ).toBe(true);
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
  it.each(['ip', 'sourceIP', 'localIP'])(
    'rejects malformed %s literals before applying and accepts their corrected CIDRs',
    (key) => {
      const node = makeNode('routing-filter', { x: 0, y: 0 });
      const table = readRuleTable(node.data.settings);
      table.rules = [
        {
          id: 'cidr',
          name: 'Local range',
          output: table.defaultOutput,
          enabled: true,
          matchAll: false,
          conditions: {},
        },
      ];
      for (const value of [
        '192.0.2.0/24/',
        '192.0.2.0/24//ignored',
        '2001:db8::/64/',
        '192.000.2.1',
      ]) {
        table.rules[0].conditions = { [key]: value };
        Object.assign(node.data.settings, tableSettings(table));
        expect(ruleTableProblems(node.data), value).toContainEqual(
          expect.objectContaining({ severity: 'error', rowId: 'cidr', fieldKey: key }),
        );
      }
      for (const value of ['192.0.2.0/24', '2001:db8::/64', '!192.0.2.0/24']) {
        table.rules[0].conditions = { [key]: value };
        Object.assign(node.data.settings, tableSettings(table));
        expect(ruleTableProblems(node.data), value).toEqual([]);
      }
    },
  );
  it('requires explicit match-all instead of silently accepting an empty traffic rule', () => {
    const node = createRoutingExample().nodes.find((item) => item.id === 'routes')!;
    const table = readRuleTable(node.data.settings);
    table.rules[0].conditions = {};
    Object.assign(node.data.settings, tableSettings(table));
    expect(ruleTableProblems(node.data)[0].message).toContain('add a condition');
  });
});

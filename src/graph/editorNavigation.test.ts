import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { createRoutingExample } from './example';
import { diagnoseRuntimeGraph } from './diagnostics';
import { diagnoseXrayGraph } from './xrayCompiler';
import { ruleTableProblems, readRuleTable, tableSettings } from './rules';
import { dnsProblems, newDnsServer } from './dns';
import { dnsDiagnosticTab, hasNodeEditor, policyDiagnosticTab } from './editorNavigation';

it('retains rule identity and condition through graph and Xray diagnostics', () => {
  const graph = createRoutingExample(),
    filter = graph.nodes.find((n) => n.id === 'routes')!;
  const table = readRuleTable(filter.data.settings);
  table.rules[1].conditions.sourcePort = 'bad-port';
  Object.assign(filter.data.settings, tableSettings(table));
  const expected = { severity: 'error', fieldKey: 'sourcePort', rowId: table.rules[1].id };
  expect(ruleTableProblems(filter.data)).toContainEqual(expect.objectContaining(expected));
  expect(diagnoseRuntimeGraph(graph)).toContainEqual(
    expect.objectContaining({ ...expected, nodeId: filter.id }),
  );
  expect(diagnoseXrayGraph(graph)).toContainEqual(
    expect.objectContaining({ ...expected, nodeId: filter.id }),
  );
});

it('identifies the second invalid DNS server and duplicate output, rather than the first row', () => {
  const node = makeNode('dns-servers', { x: 0, y: 0 }),
    first = newDnsServer(),
    second = newDnsServer();
  first.address = '1.1.1.1';
  second.address = 'invalid address';
  node.data.settings.servers = JSON.stringify([first, second]);
  expect(dnsProblems(node.data)).toContainEqual(
    expect.objectContaining({ rowId: second.id, fieldKey: 'address' }),
  );
  const filter = makeNode('routing-filter', { x: 0, y: 0 }),
    table = readRuleTable(filter.data.settings);
  table.outputs.push({ id: 'duplicate', name: table.outputs[0].name });
  Object.assign(filter.data.settings, tableSettings(table));
  expect(ruleTableProblems(filter.data)).toContainEqual(
    expect.objectContaining({ outputId: 'duplicate', fieldKey: 'name' }),
  );
});

it('identifies missing paths and maps location metadata to a sensible editor section', () => {
  const graph = createRoutingExample();
  graph.edges = [];
  expect(diagnoseRuntimeGraph(graph)).toContainEqual(
    expect.objectContaining({ nodeId: graph.nodes[0].id, portId: 'data' }),
  );
  expect(
    dnsDiagnosticTab({ severity: 'error', message: '', rowId: 'resolver', fieldKey: 'address' }),
  ).toBe('main');
  expect(
    dnsDiagnosticTab({ severity: 'error', message: '', outputId: 'fallback', fieldKey: 'name' }),
  ).toBe('settings');
  expect(
    policyDiagnosticTab(makeNode('policy-group', { x: 0, y: 0 }).data, {
      severity: 'error',
      message: '',
      fieldKey: 'strategyExtra',
    }),
  ).toBe('strategy');
  expect(hasNodeEditor(makeNode('windivert-inbound', { x: 0, y: 0 }).data)).toBe(true);
});

it.each(['fallbackMode', 'fallbackFirst', 'parallel'])(
  'opens Preferences for DNS %s diagnostics, including output-scoped errors',
  (fieldKey) => {
    expect(
      dnsDiagnosticTab({ severity: 'error', message: '', fieldKey, outputId: 'default' }),
    ).toBe('main');
  },
);

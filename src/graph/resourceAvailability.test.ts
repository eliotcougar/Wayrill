import { parseResources } from './resources';
import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { readRuleTable, tableSettings } from './rules';
import { unavailableRuleIds } from './resourceAvailability';
import { factoryDefaults } from './defaults';
import type { GraphState } from './types';

it('disables only wholly unavailable rules, including AND constraints and compiled alternatives', () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 });
  const table = readRuleTable(node.data.settings);
  const rule = {
    id: 'gone',
    name: 'Gone',
    enabled: true,
    output: table.defaultOutput,
    matchAll: false,
    conditions: { domain: 'geosite:gone' },
  };
  table.rules = [
    rule,
    { ...rule, id: 'or', conditions: { domain: 'geosite:gone', ip: '192.0.2.1' } },
    {
      ...rule,
      id: 'and',
      targetMatch: 'all',
      conditions: { domain: 'geosite:gone', ip: '192.0.2.1' },
    },
    { ...rule, id: 'partial', conditions: { domain: 'geosite:gone\nfull:keep.example' } },
    { ...rule, id: 'source', conditions: { domain: 'full:keep.example', sourceIP: 'geoip:gone' } },
    {
      ...rule,
      id: 'app',
      applications: [
        { kind: 'process', mode: 'name', value: 'browser.exe', children: false, enabled: true },
      ],
      conditions: { domain: 'geosite:gone' },
    },
  ];
  node.data.settings = { ...node.data.settings, ...tableSettings(table) };
  const graph: GraphState = {
    name: 'Resources',
    nodes: [node],
    edges: [],
    defaults: {
      ...factoryDefaults(),
      resources: parseResources({
        mode: 'url',
        packaged: 'original',
        autoUpdate: false,
        intervalHours: 24,
        extras: [],
        geoipUrl: 'https://example.com/ip.dat',
        geositeUrl: 'https://example.com/site.dat',
      }),
    },
  };
  const before = structuredClone(graph);
  expect([
    ...unavailableRuleIds(node, graph, {
      skippedSelectors: [
        { selector: 'ext:global-geosite.dat:gone', context: 'Traffic rule' },
        { selector: 'ext:global-geoip.dat:gone', context: 'Traffic rule' },
      ],
    }),
  ]).toEqual(['gone', 'and', 'source']);
  expect(graph).toEqual(before);
});

import { expect, it } from 'vitest';
import { addCompanionDomain } from './companionRules';
import { makeNode } from './graph/catalog';
import { readRuleTable, tableSettings, type RuleTable } from './graph/rules';
import { attachTrafficSource, refreshTrafficSource } from './graph/trafficRuleSource';
import { parseTrafficRules } from './graph/trafficRuleImport';
import type { GraphState } from './graph/types';

const base: RuleTable = {
  outputs: [
    { id: 'proxy', name: 'Main' },
    { id: 'direct', name: 'Local' },
  ],
  rules: [],
  defaultOutput: 'direct',
};
const source = (domain: string) =>
  parseTrafficRules(
    JSON.stringify([
      { id: 'web', remarks: 'Web', domain: [domain], port: '443', outboundTag: 'proxy' },
    ]),
  );
function graph(table: RuleTable): GraphState {
  const filter = makeNode('routing-filter', { x: 0, y: 0 }, 'filter');
  filter.data.settings = {
    ...filter.data.settings,
    ...tableSettings(table),
    domainStrategy: 'IPIfNonMatch',
  };
  return {
    name: 'Current draft',
    nodes: [filter, makeNode('direct-outbound', { x: 400, y: 0 }, 'direct')],
    edges: [],
  };
}
const read = (value: GraphState) => readRuleTable(value.nodes[0].data.settings);

it('adds to a synced rule without replacing current conditions or draft changes; additions survive refresh', () => {
  const table = attachTrafficSource(
    base,
    source('domain:source.test'),
    { 'outbound:proxy': 'proxy' },
    'replace',
    { kind: 'url', location: 'https://example.test/rules', allowHttp: false, viaWayrill: false },
  );
  table.rules[0].enabled = false;
  const before = graph(table);
  const original = structuredClone(before);
  const next = addCompanionDomain(before, {
    filterId: 'filter',
    ruleId: table.rules[0].id,
    entry: 'full:page.test',
  });
  expect(before).toEqual(original);
  expect(next.nodes[1]).toBe(before.nodes[1]);
  expect(next.nodes[0].data.settings.domainStrategy).toBe('IPIfNonMatch');
  expect(read(next).rules[0]).toMatchObject({
    enabled: false,
    output: 'proxy',
    conditions: { port: '443', domain: 'domain:source.test\nfull:page.test' },
  });
  const refreshed = refreshTrafficSource(read(next), source('domain:new.test'));
  expect(refreshed.rules[0].conditions).toEqual({
    port: '443',
    domain: 'domain:new.test\nfull:page.test',
  });
  expect(() =>
    addCompanionDomain(next, {
      filterId: 'filter',
      ruleId: table.rules[0].id,
      entry: 'full:PAGE.test',
    }),
  ).toThrow(/already/);
});

it('creates a conditional rule before a catch-all and rejects stale targets and invalid entries', () => {
  const before = graph({
    ...base,
    rules: [
      { id: 'all', name: 'All', enabled: true, output: 'direct', matchAll: true, conditions: {} },
    ],
  });
  const next = addCompanionDomain(before, {
    filterId: 'filter',
    ruleId: '',
    entry: 'geosite:google',
    newRule: { name: 'Google', output: 'proxy' },
  });
  expect(read(next).rules.map((rule) => rule.name)).toEqual(['Google', 'All']);
  expect(read(next).rules[0]).toMatchObject({
    enabled: true,
    matchAll: false,
    output: 'proxy',
    conditions: { domain: 'geosite:google' },
  });
  for (const changes of [
    { filterId: 'missing' },
    { ruleId: 'missing' },
    { ruleId: 'all' },
    { entry: 'full:a.test\nfull:b.test' },
    { entry: '# comment' },
    { entry: 'https://a.test/private' },
  ]) {
    expect(() =>
      addCompanionDomain(next, {
        filterId: 'filter',
        ruleId: read(next).rules[0].id,
        entry: 'full:page.test',
        ...changes,
      }),
    ).toThrow();
  }
});

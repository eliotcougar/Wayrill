import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { readDnsFilter, dnsFilterSettings, newDnsRoute } from './dns';
import {
  importDnsRules,
  refreshDnsSource,
  editSourcedDnsRule,
  parseDnsRules,
  exportDnsRules,
  detachDnsSource,
  remapDnsSource,
} from './dnsRuleSource';
import { parseGraph, serializeGraph } from './model';
import { renameResourceReferences, factoryResources } from './resources';
import type { DnsFilter } from './dns';

const location = {
  kind: 'url' as const,
  location: 'https://example.test/dns-rules.json',
  allowHttp: false,
  viaWayrill: true,
};
const source = (): DnsFilter => ({
  outputs: [
    { id: 'fallback', name: 'Fallback', fallback: true },
    { id: 'local', name: 'Local', fallback: false },
  ],
  rules: [
    {
      ...newDnsRoute('local', 'provider'),
      name: 'Regional sites',
      domains: 'domain:source.test',
      expectedIPs: '192.0.2.0/24',
      unexpectedIPs: '203.0.113.1',
      skipFallback: false,
    },
  ],
  fallbackMode: 'when-unmatched',
  parallel: true,
});
const target = () => ({
  ...source(),
  outputs: [
    { id: 'default', name: 'Fallback', fallback: true },
    { id: 'regional', name: 'Local', fallback: false },
  ],
  rules: [],
});
const attach = () => importDnsRules(target(), source(), { local: 'regional' }, 'replace', location);

it('refreshes provider rows by identity while preserving local entries, switches, routing, order and removed customized rows', () => {
  const filter = attach();
  const initial = filter.rules[0];
  filter.rules[0] = editSourcedDnsRule(initial, {
    domains: 'domain:source.test\ndomain:mine.test',
    expectedIPs: '192.0.2.0/24\n198.51.100.1',
    unexpectedIPs: '',
    enabled: false,
    output: 'default',
    finalQuery: true,
  });
  filter.rules.unshift({ ...newDnsRoute('regional', 'personal'), domains: 'full:personal.test' });
  const upstream = source();
  upstream.rules[0].domains = 'domain:updated.test\nDOMAIN:MINE.TEST';
  upstream.rules[0].expectedIPs = '192.0.2.0/24\n198.51.100.2';
  filter.fallbackMode = 'disabled';
  filter.parallel = false;
  const next = refreshDnsSource(filter, parseDnsRules(exportDnsRules(upstream, 'Provider')), {});
  expect(next.rules.map((rule) => rule.id)).toEqual(['personal', initial.id]);
  expect(next.rules[1]).toMatchObject({
    enabled: false,
    output: 'default',
    finalQuery: true,
    domains: 'domain:updated.test\ndomain:mine.test',
    expectedIPs: '192.0.2.0/24\n198.51.100.2\n198.51.100.1',
    unexpectedIPs: '',
  });
  expect(next.fallbackMode).toBe('disabled');
  expect(next.parallel).toBe(false);
  expect(next.outputs).toEqual(filter.outputs);
  const omitted = refreshDnsSource(next, { ...upstream, rules: [] }, {});
  expect(omitted.rules[1].source?.missing).toBe(true);
  expect(refreshDnsSource(attach(), { ...upstream, rules: [] }, {}).rules).toEqual([]);
  expect(filter.rules[1].domains).toContain('domain:source.test');
});

it('keeps source metadata through graph/export round trips, remaps every destination and can export an independent snapshot', () => {
  const filter = attach();
  filter.rules[0] = editSourcedDnsRule(filter.rules[0], {
    output: 'default',
    domains: 'domain:source.test\nfull:mine.test',
  });
  const node = makeNode('dns-routing-filter', { x: 0, y: 0 });
  Object.assign(node.data.settings, dnsFilterSettings(filter));
  const graph = { name: 'DNS source', nodes: [node], edges: [] };
  expect(readDnsFilter(parseGraph(serializeGraph(graph)).nodes[0].data.settings)).toEqual(filter);
  expect(parseDnsRules(exportDnsRules(filter, 'DNS source'))).toEqual(filter);
  const embedded = parseDnsRules(exportDnsRules(filter, 'DNS source', true));
  expect(embedded.source).toBeUndefined();
  expect(embedded.rules[0].source).toBeUndefined();
  expect(embedded.rules[0].domains).toContain('full:mine.test');
  const remapped = remapDnsSource(
    filter,
    new Map([
      ['regional', 'other'],
      ['default', 'fallback-2'],
    ]),
  );
  expect(remapped.source?.bindings.local).toBe('other');
  expect(remapped.rules[0].output).toBe('fallback-2');
  expect(remapped.rules[0].source?.base.output).toBe('other');
  expect(remapped.rules[0].source?.edits.fields?.output).toBe('fallback-2');
  expect(detachDnsSource(filter).rules[0].domains).toContain('full:mine.test');
});

it('rejects malformed updates atomically and never revives an emptied constraint as an unrestricted preference', () => {
  const filter = attach(),
    before = structuredClone(filter),
    upstream = source();
  filter.rules[0] = editSourcedDnsRule(filter.rules[0], { domains: '' });
  const next = refreshDnsSource(filter, upstream, {});
  expect(next.rules[0].enabled).toBe(false);
  upstream.rules.push({ ...upstream.rules[0] });
  expect(() =>
    parseDnsRules(JSON.stringify({ format: 'wayrill.dns-rules', version: 1, ...upstream })),
  ).toThrow(/duplicate/);
  const snapshot = JSON.stringify(before);
  expect(() => refreshDnsSource(before, source(), { local: 'missing' })).toThrow();
  expect(JSON.stringify(before)).toBe(snapshot);
  expect(() => parseDnsRules('{"routing":{"rules":[]}}')).toThrow(/DNS rules export/);
});

it('records a custom resource rename as an override so refresh cannot restore the removed filename', () => {
  const resources = factoryResources();
  resources.files.push({
    id: 'office',
    name: 'office.dat',
    kind: 'geosite',
    url: '',
    intervalHours: 24,
    autoUpdate: false,
    enabled: false,
    throughWayrill: false,
  });
  const node = makeNode('dns-routing-filter', { x: 0, y: 0 });
  const incoming = source();
  incoming.rules[0].domains = 'ext:office.dat:work';
  const filter = importDnsRules(target(), incoming, { local: 'regional' }, 'replace', location);
  Object.assign(node.data.settings, dnsFilterSettings(filter));
  const graph = {
    name: 'Rename',
    nodes: [node],
    edges: [],
    defaults: { version: 1 as const, settings: {}, resources },
  };
  const renamed = structuredClone(resources);
  renamed.files.find((file) => file.id === 'office')!.name = 'work.dat';
  const edited = readDnsFilter(renameResourceReferences(graph, renamed).nodes[0].data.settings);
  expect(refreshDnsSource(edited, incoming, {}).rules[0].domains).toBe('ext:work.dat:work');
});

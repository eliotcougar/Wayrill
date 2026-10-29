import { importProfiles } from '../profiles/import';
import { policyProfile, policyProfileId, emptyPolicySources } from './policySources';
import { createPolicyExample } from './policyExample';
import { describe, expect, it } from 'vitest';
import {
  factoryResources,
  parseResources,
  resourceCompilationGraph,
  selectResource,
} from './resources';
import { applyDefaults, factoryDefaults } from './defaults';
import { createTrafficExample } from './example';
import { parseGraph, serializeGraph } from './model';
import { readRuleTable, tableSettings } from './rules';
import { compileRuntimeGraph } from './runtime';
import { attachTrafficSource, refreshTrafficSource } from './trafficRuleSource';
import { parseTrafficRules } from './trafficRuleImport';
const russianResources = () =>
  selectResource(
    selectResource(factoryResources(), 'packaged-ru-geoip', true),
    'packaged-ru-geosite',
    true,
  );
const officeFile = {
  id: 'qa-id',
  name: 'office.dat',
  kind: 'geosite' as const,
  url: '',
  enabled: false,
  autoUpdate: false,
  intervalHours: 24,
  throughWayrill: false,
};
describe('shared resource files', () => {
  it('keeps a renamed direct reference as a local override when URL rules refresh', () => {
    const graph = createTrafficExample();
    graph.defaults = {
      ...factoryDefaults(),
      resources: { ...factoryResources(), files: [...factoryResources().files, officeFile] },
    };
    const node = graph.nodes.find((node) => node.id === 'routes')!;
    const original = readRuleTable(node.data.settings);
    const imported = parseTrafficRules(
      JSON.stringify([
        { id: 'office', remarks: 'Office', domain: ['ext:office.dat:work'], outboundTag: 'proxy' },
      ]),
    );
    const sourced = attachTrafficSource(
      original,
      imported,
      { 'outbound:proxy': original.defaultOutput },
      'replace',
      {
        kind: 'url',
        location: 'https://example.net/rules.json',
        allowHttp: false,
        viaWayrill: false,
      },
    );
    node.data.settings = { ...node.data.settings, ...tableSettings(sourced) };
    const defaults = structuredClone(graph.defaults);
    defaults.resources!.files.find((file) => file.id === officeFile.id)!.name = 'company.dat';
    const renamed = applyDefaults(graph, defaults);
    const current = readRuleTable(renamed.nodes.find((row) => row.id === node.id)!.data.settings);
    expect(refreshTrafficSource(current, imported).rules[0].conditions.domain).toBe(
      'ext:company.dat:work',
    );
    expect(current.rules[0].source?.base.conditions.domain).toBe('ext:office.dat:work');
  });
  it('rewrites plain selectors to the selected files without changing explicit regional selectors or saved graphs', () => {
    const graph = createTrafficExample();
    graph.defaults = { ...factoryDefaults(), resources: russianResources() };
    const traffic = graph.nodes.find((node) => node.id === 'routes')!;
    const table = readRuleTable(traffic.data.settings);
    table.rules[0].conditions = { domain: 'geosite:private', ip: 'geoip:ru' };
    traffic.data.settings = { ...traffic.data.settings, ...tableSettings(table) };
    const dns = graph.nodes.find((node) => node.data.kind === 'dns-routing-filter')!;
    const rules = JSON.parse(String(dns.data.settings.rules));
    rules[0].domains = 'geosite:private';
    rules[0].expectedIPs = 'geoip:ru';
    dns.data.settings.rules = JSON.stringify(rules);
    const before = serializeGraph(graph),
      compiled = JSON.stringify(compileRuntimeGraph(graph).config);
    expect(compiled).toContain('ext:ru-geosite.dat:private');
    expect(compiled).toContain('ext:ru-geoip.dat:ru');
    expect(serializeGraph(graph)).toBe(before);
    expect(
      parseGraph(before).defaults?.resources?.files.find((file) => file.name === 'ru-geosite.dat')
        ?.enabled,
    ).toBe(true);
    for (const selector of [
      'ext:geosite.dat:private',
      'ext:ru-geosite.dat:ru-blocked',
      'ext:ir-geosite.dat:ir',
      'ext:cn-geosite.dat:gfw',
    ]) {
      graph.nodes[0].data.settings.domain = selector;
      expect(resourceCompilationGraph(graph).nodes[0].data.settings.domain).toBe(selector);
    }
    graph.nodes[0].data.settings.ip = 'ext:geoip.dat:private';
    expect(resourceCompilationGraph(graph).nodes[0].data.settings.ip).toBe('ext:geoip.dat:private');
  });
  it('renames filter and DNS references together with defaults, preserving labels, credentials, IDs and graph undo data', () => {
    const graph = createTrafficExample();
    graph.defaults = {
      ...factoryDefaults(),
      resources: { ...factoryResources(), files: [...factoryResources().files, officeFile] },
    };
    const traffic = graph.nodes.find((node) => node.id === 'routes')!;
    const table = readRuleTable(traffic.data.settings);
    table.rules[0].conditions = {
      domain: '# Company rules\n  ext:office.dat:work\nregexp:keep,commas\\.example$',
      ip: 'ext-ip:other.dat:private',
    };
    traffic.data.settings = { ...traffic.data.settings, ...tableSettings(table) };
    const dns = graph.nodes.find((node) => node.data.kind === 'dns-routing-filter')!;
    const rows = JSON.parse(String(dns.data.settings.rules));
    rows[0].domains = 'ext-domain:office.dat:work';
    dns.data.settings.rules = JSON.stringify(rows);
    const handler = graph.nodes.find((node) => node.data.kind === 'dns-handler')!;
    handler.data.settings.hosts = '{"ext:office.dat:work":"192.0.2.1"}';
    traffic.data.label = 'ext:office.dat:work';
    traffic.data.settings.password = 'ext:office.dat:work';
    const before = serializeGraph(graph);
    const next = applyDefaults(graph, {
      ...graph.defaults,
      resources: {
        ...graph.defaults.resources!,
        files: graph.defaults.resources!.files.map((file) =>
          file.id === officeFile.id ? { ...file, name: 'company.dat' } : file,
        ),
      },
    });
    const actual = next.nodes.find((node) => node.id === traffic.id)!;
    expect(readRuleTable(actual.data.settings).rules[0].conditions).toEqual({
      domain: '# Company rules\n  ext:company.dat:work\nregexp:keep,commas\\.example$',
      ip: 'ext-ip:other.dat:private',
    });
    expect(String(next.nodes.find((node) => node.id === dns.id)!.data.settings.rules)).toContain(
      'ext-domain:company.dat:work',
    );
    expect(
      String(next.nodes.find((node) => node.id === handler.id)!.data.settings.hosts),
    ).toContain('ext:company.dat:work');
    expect(actual.data.label).toBe(traffic.data.label);
    expect(actual.data.settings.password).toBe(traffic.data.settings.password);
    expect(next.edges).toEqual(graph.edges);
    expect(serializeGraph(graph)).toBe(before);
  });
  it('reports a missing default instead of silently substituting another file', () => {
    const graph = createTrafficExample();
    graph.defaults = {
      ...factoryDefaults(),
      resources: selectResource(factoryResources(), 'packaged-geosite', false),
    };
    graph.nodes[0].data.settings.hosts = '{"geosite:private":"192.0.2.1"}';
    expect(() => resourceCompilationGraph(graph)).toThrow(/Select a default GeoSite/);
  });
  it('validates paths, duplicate names, update intervals and HTTPS sources', () => {
    for (const url of [
      'http://example.net/data',
      'https://user:secret@example.net/data',
      'file:///secret',
    ]) {
      expect(() =>
        parseResources({ ...factoryResources(), files: [{ ...officeFile, url }] }),
      ).toThrow(/HTTPS/);
    }
    for (const name of ['../bad.dat', 'C:\\bad.dat', 'bad/other.dat', 'CON.dat', 'lpt1.dat'])
      expect(() =>
        parseResources({ ...factoryResources(), files: [{ ...officeFile, name }] }),
      ).toThrow();
    expect(() =>
      parseResources({ ...factoryResources(), files: [{ ...officeFile, intervalHours: NaN }] }),
    ).toThrow();
    expect(() =>
      parseResources({
        ...factoryResources(),
        files: [officeFile, { ...officeFile, id: 'other', name: 'Office.dat' }],
      }),
    ).toThrow(/unique/);
    expect(() =>
      parseResources({ ...factoryResources(), files: [{ ...officeFile, autoUpdate: true }] }),
    ).toThrow(/URL/);
  });
});
it('updates valid nested profile identities for actual resource changes but never legitimizes corrupt identities', () => {
  const graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  graph.defaults!.resources = russianResources();
  const entry = importProfiles('socks://example.net:1080#Public').groups[0].entries[0];
  entry.profile!.settings.json = JSON.stringify({
    sniffing: { domainsExcluded: ['geosite:private'] },
  });
  const ref = policyProfile(entry);
  node.data.settings.sources = JSON.stringify({ ...emptyPolicySources(), manual: [ref] });
  const rewritten = JSON.parse(
    String(
      resourceCompilationGraph(graph).nodes.find((n) => n.id === node.id)!.data.settings.sources,
    ),
  ).manual[0];
  expect(rewritten.profile.settings.json).toContain('ext:ru-geosite.dat:private');
  expect(rewritten.id).toBe(policyProfileId(rewritten.profile));
  expect(rewritten.id).not.toBe(ref.id);
  ref.id = '00000000000000000000000000000000';
  node.data.settings.sources = JSON.stringify({ ...emptyPolicySources(), manual: [ref] });
  expect(
    JSON.parse(
      String(
        resourceCompilationGraph(graph).nodes.find((n) => n.id === node.id)!.data.settings.sources,
      ),
    ).manual[0].id,
  ).toBe(ref.id);
});

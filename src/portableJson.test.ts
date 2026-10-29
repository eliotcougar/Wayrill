import { expect, it } from 'vitest';
import { portableBackup } from './portableJson';
import { createContent, validateContent, prepareRestore } from './backup/model';
import { makeNode } from './graph/catalog';
import { createDnsExample } from './graph/example';
import { enableDefaults, factoryDefaults } from './graph/defaults';
import { compileRuntimeGraph } from './graph/runtime';
import { parseEntry, type Stash, type Profile } from './profiles/import';
import { defaultGroup } from './profiles/stashModel';
import { policyProfileId, readPolicySources } from './graph/policySources';
import { readProxyChain } from './graph/proxyChains';
import { TRAFFIC_UNITS_KEY } from './trafficUnits';
import type { GraphState } from './graph/types';

const stash = (): Stash => ({ format: 'wayrill.stash', version: 3, groups: [defaultGroup()] });
const empty = (): GraphState => ({
  name: 'Empty',
  nodes: [],
  edges: [],
  defaults: factoryDefaults(),
});
const roundTrip = (content: unknown) =>
  validateContent(
    portableBackup(JSON.parse(JSON.stringify(portableBackup(content, 'write'))), 'read'),
  );

it('exports nested settings as JSON objects and lists, restoring the same executable graph', () => {
  const graph = enableDefaults(createDnsExample());
  const content = createContent(
    'full',
    graph,
    stash(),
    { [TRAFFIC_UNITS_KEY]: '{"rate":"bits","amount":"bytes"}' },
    [],
  );
  const wire = portableBackup(content, 'write') as any;
  const traffic = wire.graph.nodes.find((n: any) => n.data.kind === 'routing-filter').data;
  expect(traffic.settings.rules).toBeInstanceOf(Array);
  expect(traffic.settings.outputs).toBeInstanceOf(Array);
  expect(typeof wire.preferences[TRAFFIC_UNITS_KEY]).toBe('object');
  const dns = wire.graph.nodes.find((n: any) => n.data.kind === 'dns-routing-filter').data;
  expect(dns.settings.rules[0].domains).toEqual(['domain:lan', 'domain:home.arpa']);
  const decoded = roundTrip(content);
  const restored = prepareRestore(
    decoded,
    { graph: true, stash: true, preferences: true, filters: false, stashMode: 'replace' },
    empty(),
    stash(),
  );
  expect(compileRuntimeGraph(restored.graph!)).toEqual(compileRuntimeGraph(graph));
  expect(restored.preferences).toEqual(content.preferences);
});

it('expands Stash templates and nested prepared profiles without treating credentials as JSON', () => {
  const library = stash();
  const server = parseEntry('socks://127.0.0.1:1080#Local');
  server.profile!.settings.password = '{"this":"is a literal password"}';
  const leaf = makeNode('vless-outbound', { x: 0, y: 0 });
  leaf.data.settings.headers = '{ "X-Test": "yes" }';
  const profile: Profile = { kind: 'vless-outbound', settings: leaf.data.settings };
  const ref = { type: 'profile', id: policyProfileId(profile), name: 'Nested', profile };
  const chain = makeNode('proxy-chain', { x: 0, y: 0 });
  chain.data.settings.steps = JSON.stringify({ version: 1, steps: [{ id: 'hop', outbound: ref }] });
  const chainProfile: Profile = { kind: 'proxy-chain', settings: chain.data.settings };
  const policy = makeNode('policy-group', { x: 0, y: 0 });
  policy.data.settings.sources = JSON.stringify({
    version: 1,
    manual: [
      { type: 'profile', id: policyProfileId(chainProfile), name: 'Chain', profile: chainProfile },
    ],
    subscriptions: [],
    fallback: ref,
  });
  library.groups[0].entries = [server];
  const graph = { ...empty(), nodes: [policy] };
  const content = createContent('full', graph, library, {}, []);
  const wire = portableBackup(content, 'write') as any;
  expect(wire.stash.version).toBe(3);
  expect(wire.stash.groups[0]).not.toHaveProperty('settingsDefaults');
  expect(wire.stash.groups[0].entries[0].profile.settings.password).toBe(
    server.profile!.settings.password,
  );
  const nested = wire.graph.nodes[0].data.settings.sources.manual[0].profile.settings.steps;
  expect(nested.steps[0].outbound.profile.settings.headers).toEqual({ 'X-Test': 'yes' });
  const restored = prepareRestore(
    roundTrip(content),
    { graph: true, stash: true, preferences: false, filters: false, stashMode: 'replace' },
    empty(),
    stash(),
  );
  const sources = readPolicySources(restored.graph!.nodes[0].data);
  const composite = sources.manual[0];
  if (composite.type !== 'profile') throw new Error('Expected prepared profile');
  expect(composite.id).toBe(policyProfileId(composite.profile));
  const hop = readProxyChain({ ...chain.data, settings: composite.profile.settings }).steps[0]
    .outbound;
  if (hop.type !== 'profile') throw new Error('Expected prepared hop');
  expect(hop.id).toBe(policyProfileId(hop.profile));
  expect(restored.stash!.groups[0].entries[0].profile!.settings.password).toBe(
    server.profile!.settings.password,
  );
});

it('rejects non-text rule list entries without publishing a partial restore', () => {
  const graph = enableDefaults(createDnsExample());
  const wire = portableBackup(createContent('graph', graph, stash(), {}, []), 'write') as any;
  wire.graph.nodes.find(
    (n: any) => n.data.kind === 'routing-filter',
  ).data.settings.rules[0].conditions.domain = [42];
  expect(() => portableBackup(wire, 'read')).toThrow('Rule entries must be text');
});

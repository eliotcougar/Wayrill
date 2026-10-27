/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDefaults,
  enableDefaults,
  factoryDefaults,
  overrideSetting,
  parseDefaults,
  resetNodeDefaults,
  resolveGraph,
} from './defaults';
import { createTrafficExample } from './example';
import { makeNode } from './catalog';
import { inboundPreview } from './inbounds';
import { outboundBundle, outboundPreview } from './outbounds';
import { compileDnsGraph } from './dnsCompilation';
import { compileRuntimeGraph } from './runtime';
import { diagnoseGraph, parseGraph, serializeGraph, toDocument, updateGraphNode } from './model';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  redoWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';
import { normalizeUserAgent } from './trafficTuning';

const graph = () => enableDefaults(createTrafficExample());
const preferred = (g: ReturnType<typeof graph>) => g.nodes.find((n) => n.id === 'preferred')!;
describe('global defaults and explicit overrides', () => {
  it('uses Windows UDP burst buffers in factory defaults and retains explicit overrides', () => {
    const fresh = graph();
    const capture = makeNode('windivert-inbound', { x: 0, y: 0 }, 'capture');
    const withCapture = resolveGraph({ ...fresh, nodes: [...fresh.nodes, capture] });
    expect(inboundPreview(withCapture.nodes.at(-1)!.data)).not.toHaveProperty('streamSettings');
    const options = [4098, 4097].map((opt) => ({
      system: 'windows',
      network: 'udp',
      level: '65535',
      opt: String(opt),
      value: '262144',
      type: 'int',
    }));
    expect(inboundPreview(fresh.nodes.find((n) => n.id === 'socks')!.data)).not.toHaveProperty(
      'streamSettings',
    );
    expect(compileRuntimeGraph(fresh).config.env).toMatchObject({
      WAYRILL_UDP_LISTENER_RECEIVE_BYTES: '262144',
      WAYRILL_UDP_LISTENER_SEND_BYTES: '262144',
    });
    expect(outboundPreview(preferred(fresh).data)).toMatchObject({
      streamSettings: { sockopt: { customSockopt: options } },
    });
    const explicit = overrideSetting(
      preferred(fresh).data,
      'sockoptExtra',
      JSON.stringify({
        customSockopt: [
          {
            system: 'windows',
            network: 'udp',
            level: '65535',
            opt: '4098',
            value: '524288',
            type: 'int',
          },
        ],
      }),
    );
    const updated = updateGraphNode(fresh, preferred(fresh).id, explicit);
    expect(outboundPreview(preferred(updated).data)).toMatchObject({
      streamSettings: { sockopt: { customSockopt: [{ value: '524288' }] } },
    });
    const inheritedCore = applyDefaults(fresh, { version: 1, settings: {} });
    expect(outboundPreview(preferred(inheritedCore).data)).not.toHaveProperty(
      'streamSettings.sockopt.customSockopt',
    );
  });

  it('inherits live defaults on both inputs and connecting outputs without changing identity', () => {
    const before = graph(),
      defaults = factoryDefaults();
    Object.assign(defaults.settings, {
      udp: false,
      sniffing: false,
      routeOnly: false,
      fingerprint: 'firefox',
      userAgent: 'Wayrill-QA',
      tcpKeepAliveIdle: 37,
      proxyDomainStrategy: 'UseIPv4',
      directDomainStrategy: 'ForceIPv4',
    });
    const changed = applyDefaults(before, defaults);
    expect(inboundPreview(changed.nodes.find((n) => n.id === 'socks')!.data)).toMatchObject({
      settings: { udp: false },
      sniffing: { enabled: false },
    });
    expect(
      inboundPreview(changed.nodes.find((n) => n.id === 'http')!.data).settings,
    ).not.toHaveProperty('udp');
    const outbound = outboundPreview(preferred(changed).data);
    expect(outbound).toMatchObject({
      streamSettings: {
        tlsSettings: { fingerprint: 'firefox' },
        sockopt: { tcpKeepAliveIdle: 37, domainStrategy: 'UseIPv4' },
        xhttpSettings: { extra: { headers: { 'User-Agent': 'Wayrill-QA' } } },
      },
    });
    expect(preferred(changed).data.settings.address).toBe(preferred(before).data.settings.address);
    expect(preferred(changed).data.settings.id).toBe(preferred(before).data.settings.id);
    expect(preferred(before).data.settings.fingerprint).toBe('chrome');
    const newNode = makeNode('vless-outbound', { x: 0, y: 0 }, 'new');
    const withNew = resolveGraph({ ...changed, nodes: [...changed.nodes, newNode] });
    expect(withNew.nodes.at(-1)!.data.settings.fingerprint).toBe('firefox');
  });
  it('retains explicit false and blank overrides, even when equal to the old default', () => {
    let g = graph();
    const node = preferred(g);
    g = updateGraphNode(g, node.id, overrideSetting(node.data, 'userAgent', ''));
    g = updateGraphNode(g, node.id, overrideSetting(preferred(g).data, 'muxEnabled', false));
    const defaults = factoryDefaults();
    Object.assign(defaults.settings, { userAgent: 'New-Agent', muxEnabled: true });
    g = applyDefaults(g, defaults);
    expect(preferred(g).data.settings).toMatchObject({ userAgent: '', muxEnabled: false });
    expect(preferred(g).data.overrides).toEqual(
      expect.arrayContaining(['userAgent', 'muxEnabled']),
    );
    g = updateGraphNode(g, node.id, resetNodeDefaults(preferred(g).data, defaults, 'userAgent'));
    expect(preferred(g).data.settings.userAgent).toBe('New-Agent');
    defaults.settings.userAgent = 'Next-Agent';
    g = applyDefaults(g, defaults);
    expect(preferred(g).data.settings.userAgent).toBe('Next-Agent');
    expect(preferred(g).data.settings.muxEnabled).toBe(false);
  });
  it('resets one or all defaults while preserving server, credential and listener fields', () => {
    const g = graph(),
      node = preferred(g),
      defaults = factoryDefaults();
    defaults.settings.fingerprint = 'safari';
    const overridden = { ...node.data, ...overrideSetting(node.data, 'fingerprint', 'firefox') };
    const reset = resetNodeDefaults(overridden, defaults);
    expect(reset.overrides).toEqual([]);
    expect(reset.settings).toMatchObject({
      fingerprint: 'safari',
      address: node.data.settings.address,
      port: node.data.settings.port,
      id: node.data.settings.id,
      network: 'xhttp',
    });
    const input = g.nodes.find((n) => n.id === 'socks')!.data;
    expect(resetNodeDefaults(input, defaults).settings).toMatchObject({
      listen: '127.0.0.1',
      port: 2080,
      tag: 'local-socks',
    });
  });
  it('rejects graphs missing defaults or explicit inheritance metadata', () => {
    const old = toDocument(createTrafficExample());
    delete old.defaults;
    expect(() => parseGraph(JSON.stringify(old))).toThrow(/Older graph formats/);
    const missingOverrides = toDocument(createTrafficExample());
    delete missingOverrides.nodes[0].data.overrides;
    expect(() => parseGraph(JSON.stringify(missingOverrides))).toThrow(/overrides/);
  });
  it('round-trips defaults and inheritance, and includes metadata-only overrides in undo/redo', () => {
    const g = graph(),
      changed = updateGraphNode(
        g,
        'preferred',
        overrideSetting(preferred(g).data, 'fingerprint', 'chrome'),
      );
    const history = commitWorkspaceHistory(initialWorkspaceHistory(g), { graph: changed });
    expect(history.past).toHaveLength(1);
    expect(preferred(undoWorkspaceHistory(history).present.graph).data.overrides).not.toContain(
      'fingerprint',
    );
    expect(
      preferred(redoWorkspaceHistory(undoWorkspaceHistory(history)).present.graph).data.overrides,
    ).toContain('fingerprint');
    const restored = parseGraph(serializeGraph(changed));
    expect(restored.defaults).toEqual(changed.defaults);
    expect(preferred(restored).data.overrides).toEqual(preferred(changed).data.overrides);
    expect(serializeGraph(restored)).toBe(serializeGraph(changed));
  });
  it('compiles inherited values identically in runtime and DNS exports and keeps post-fragment tags', () => {
    const defaults = factoryDefaults();
    Object.assign(defaults.settings, {
      fingerprint: 'firefox',
      finalFragmentEnabled: true,
      logLevel: 'error',
      routingDomainStrategy: 'IPOnDemand',
      statistics: true,
      policy:
        '{"levels":{"0":{"connIdle":120,"bufferSize":-1}},"system":{"statsOutboundUplink":true}}',
    });
    const g = applyDefaults(graph(), defaults),
      compiled = compileRuntimeGraph(g).config;
    expect(compiled).toMatchObject({
      log: { loglevel: 'error', maskAddress: 'full' },
      routing: { domainStrategy: 'IPOnDemand' },
      policy: { levels: { '0': { connIdle: 120 } } },
      stats: {},
    });
    const dns = compileDnsGraph(g),
      outbounds = compiled.outbounds as Record<string, unknown>[];
    expect(outbounds.find((o) => o.tag === 'preferred')).toMatchObject({
      protocol: 'freedom',
      streamSettings: {
        sockopt: { dialerProxy: 'wayrill-runtime-inner-preferred' },
        finalmask: { tcp: [{ type: 'fragment' }] },
      },
    });
    expect(outbounds.find((o) => o.tag === 'wayrill-runtime-inner-preferred')).toMatchObject({
      protocol: 'vless',
      streamSettings: { tlsSettings: { fingerprint: 'firefox' } },
    });
    expect(dns.outbounds.find((o) => o.tag === 'preferred')).toMatchObject({ protocol: 'freedom' });
    expect(outbounds.filter((o) => o.tag === 'preferred')).toHaveLength(1);
    expect(outbounds.filter((o) => o.tag === 'wayrill-runtime-inner-preferred')).toHaveLength(1);
  });
  it('honors Vision compatibility and keeps XHTTP xmux separate from core mux', () => {
    const defaults = factoryDefaults();
    defaults.settings.muxEnabled = true;
    let g = applyDefaults(graph(), defaults);
    expect(outboundPreview(preferred(g).data)).not.toHaveProperty('mux');
    Object.assign(preferred(g).data.settings, { network: 'raw', flow: 'xtls-rprx-vision' });
    expect(
      diagnoseGraph(g).some((i) => i.fieldKey === 'muxConcurrency' && i.severity === 'error'),
    ).toBe(true);
    g = updateGraphNode(g, 'preferred', overrideSetting(preferred(g).data, 'muxConcurrency', -1));
    expect(compileRuntimeGraph(g).config).toBeDefined();
    expect(outboundPreview(preferred(g).data)).toMatchObject({
      mux: { enabled: true, concurrency: -1 },
    });
  });
  it('synchronizes edited JSON User-Agent and clears shadows when applying the default', () => {
    const g = graph(),
      node = preferred(g);
    Object.assign(node.data.settings, {
      network: 'ws',
      headers: '{"user-agent":"Private-Agent","X-Example":"kept"}',
    });
    const normalized = normalizeUserAgent(node.data.settings, 'headers');
    expect(normalized.settings.userAgent).toBe('Private-Agent');
    expect(normalized.found).toBe(true);
    const defaults = factoryDefaults();
    defaults.settings.userAgent = 'Global-Agent';
    const reset = resetNodeDefaults(
      { ...node.data, settings: normalized.settings },
      defaults,
      'userAgent',
    );
    expect(outboundPreview(reset)).toMatchObject({
      streamSettings: {
        wsSettings: { headers: { 'User-Agent': 'Global-Agent', 'X-Example': 'kept' } },
      },
    });
    expect(JSON.parse(String(reset.settings.headers))).not.toHaveProperty('user-agent');
  });
  it('emits transport headers correctly, without changing client application requests', () => {
    for (const network of ['raw', 'grpc', 'ws', 'httpupgrade', 'xhttp']) {
      const node = makeNode('vless-outbound', { x: 0, y: 0 });
      Object.assign(node.data.settings, {
        network,
        rawHeaderType: 'http',
        userAgent: 'Wayrill-QA',
      });
      const stream = outboundPreview(node.data).streamSettings as Record<string, any>;
      if (network === 'raw')
        expect(stream.rawSettings.header.request.headers['User-Agent']).toEqual(['Wayrill-QA']);
      else if (network === 'grpc') expect(stream.grpcSettings.user_agent).toBe('Wayrill-QA');
      else
        expect(
          stream[
            network === 'ws'
              ? 'wsSettings'
              : network === 'httpupgrade'
                ? 'httpupgradeSettings'
                : 'xhttpSettings'
          ][network === 'xhttp' ? 'extra' : 'headers'][
            network === 'xhttp' ? 'headers' : 'User-Agent'
          ],
        ).toEqual(network === 'xhttp' ? { 'User-Agent': 'Wayrill-QA' } : 'Wayrill-QA');
    }
  });
  it('round trips inherited advanced transport headers without inventing overrides', () => {
    const defaults = factoryDefaults();
    defaults.settings.xhttpExtra = '{"headers":{"User-Agent":"Shared-XHTTP-Agent","X-QA":"kept"}}';
    let g = applyDefaults(graph(), defaults);
    const before = preferred(g).data;
    const reopened = parseGraph(serializeGraph(g));
    expect(preferred(reopened).data.overrides).toEqual(before.overrides);
    expect(preferred(reopened).data.settings.userAgent).toBe('');
    expect(preferred(reopened).data.settings.xhttpExtra).toBe(defaults.settings.xhttpExtra);
    expect(outboundPreview(preferred(reopened).data)).toMatchObject({
      streamSettings: {
        xhttpSettings: { extra: { headers: { 'User-Agent': 'Shared-XHTTP-Agent' } } },
      },
    });
    g = updateGraphNode(g, 'preferred', overrideSetting(before, 'userAgent', 'Private-Agent'));
    const reset = resetNodeDefaults(preferred(g).data, defaults);
    const resetFile = parseGraph(serializeGraph(updateGraphNode(g, 'preferred', reset)));
    expect(preferred(resetFile).data.overrides).toEqual([]);
    defaults.settings.userAgent = 'Named-Global-Agent';
    expect(outboundPreview(preferred(applyDefaults(resetFile, defaults)).data)).toMatchObject({
      streamSettings: {
        xhttpSettings: {
          extra: { headers: { 'User-Agent': 'Named-Global-Agent', 'X-QA': 'kept' } },
        },
      },
    });
  });
  it('preserves an explicit multivalue RAW User-Agent over an inherited scalar', () => {
    const g = graph(),
      node = preferred(g);
    const migrated = normalizeUserAgent(
      {
        ...node.data.settings,
        network: 'raw',
        rawHeaderType: 'http',
        userAgent: 'Global-Agent',
        rawHeader: '{"request":{"headers":{"User-Agent":["One","Two"]}}}',
      },
      'rawHeader',
    );
    expect(migrated.found).toBe(true);
    expect(migrated.settings.userAgent).toBe('');
    const explicit = { ...node.data, ...overrideSetting(node.data, 'userAgent', '') };
    explicit.settings = migrated.settings;
    const defaults = factoryDefaults();
    defaults.settings.userAgent = 'Next-Global-Agent';
    const reopened = parseGraph(
      serializeGraph(applyDefaults(updateGraphNode(g, 'preferred', explicit), defaults)),
    );
    expect(outboundPreview(preferred(reopened).data)).toMatchObject({
      streamSettings: {
        rawSettings: { header: { request: { headers: { 'User-Agent': ['One', 'Two'] } } } },
      },
    });
  });
  it('reserves generated fragmentation tags in DNS fragment exports', () => {
    const g = graph();
    g.nodes.find((n) => n.data.kind === 'direct-outbound')!.data.settings.tag =
      'wayrill-runtime-inner-vless';
    expect(() => compileDnsGraph(g)).toThrow(/reserved/);
  });
  it('validates ranges, policy shapes, unknown defaults and malformed override metadata', () => {
    expect(parseDefaults(factoryDefaults()).settings).toHaveProperty('userAgent');
    for (const patch of [
      { userAgent: 'bad\nagent' },
      { fragmentLengths: '0' },
      { fragmentPackets: '0-5' },
      { fragmentDelays: '20-10' },
      { fragmentMaxSplit: '-1' },
      { policy: '{"levels":{"0":{"bufferSize":2147483647}}}' },
      { policy: '{"api":{}}' },
      { tlsExtra: '{"allowInsecure":true}' },
    ]) {
      const defaults = factoryDefaults();
      Object.assign(defaults.settings, patch);
      expect(() => parseDefaults(defaults)).toThrow();
    }
    expect(() => parseDefaults({ version: 1, settings: { unknown: true } })).toThrow(/Unknown/);
    const bad = toDocument(graph());
    preferred(bad).data.overrides = ['address'];
    expect(() => parseGraph(JSON.stringify(bad))).toThrow(/overrides/);
    delete bad.defaults;
    expect(() => parseGraph(JSON.stringify(bad))).toThrow(/overrides/);
  });
});

const core = process.env.WAYRILL_XRAY_TEST_EXE,
  fixtures = process.env.WAYRILL_XRAY_FIXTURE_DIR;
describe.skipIf(!core || !fixtures)('Global defaults official-core offline validation', () => {
  for (const name of [
    'global-outer-fragment',
    'global-inner-fragment',
    'global-both-fragments',
    'global-vision-xudp',
    'global-happy-eyeballs',
    'global-transport-policy',
    'global-hysteria-tuning',
  ])
    it(name, () => {
      const defaults = factoryDefaults();
      if (name.includes('outer') || name.includes('both')) defaults.settings.fragmentEnabled = true;
      if (name.includes('inner') || name.includes('both'))
        defaults.settings.finalFragmentEnabled = true;
      if (name.includes('fragment'))
        Object.assign(defaults.settings, {
          fragmentLengths: '50-100,100-200',
          fragmentDelays: '0,10-20',
          fragmentMaxSplit: '0-4',
        });
      if (name === 'global-happy-eyeballs')
        Object.assign(defaults.settings, {
          happyEyeballsEnabled: true,
          happyEyeballsDelay: 250,
          proxyDomainStrategy: 'UseIP',
          directDomainStrategy: 'UseIP',
        });
      if (name === 'global-transport-policy')
        Object.assign(defaults.settings, {
          userAgent: 'Wayrill-QA',
          dnsLog: true,
          policy:
            '{"levels":{"0":{"handshake":4,"connIdle":120,"uplinkOnly":2,"downlinkOnly":5,"bufferSize":-1,"statsUserUplink":true}},"system":{"statsInboundUplink":true}}',
          statistics: true,
        });
      let g = applyDefaults(graph(), defaults);
      if (name === 'global-vision-xudp') {
        Object.assign(preferred(g).data.settings, { network: 'raw', flow: 'xtls-rprx-vision' });
        defaults.settings.muxEnabled = true;
        defaults.settings.muxConcurrency = -1;
        g = applyDefaults(g, defaults);
      }
      if (name === 'global-hysteria-tuning') {
        preferred(g).data.settings.network = 'hysteria';
        preferred(g).data.settings.hysteriaPorts = '443,10000-10010';
        defaults.settings.hysteriaUp = 10;
        defaults.settings.hysteriaDown = 20;
        g = applyDefaults(g, defaults);
      }
      const config = compileRuntimeGraph(g).config;
      mkdirSync(fixtures!, { recursive: true });
      const path = join(fixtures!, name + '.json');
      writeFileSync(path, JSON.stringify(config, null, 2));
      const result = spawnSync(core!, ['run', '-test', '-config', path], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      writeFileSync(
        join(fixtures!, name + '.log'),
        String(result.stdout ?? '') + '\n' + String(result.stderr ?? ''),
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
      expect(outboundBundle(preferred(g).data).length).toBe(
        name.includes('inner') || name.includes('both') ? 2 : 1,
      );
    });
});

describe('global default list semantics', () => {
  it.each(['domainsExcluded', 'ipsExcluded'])(
    'rejects invalid %s entries even without inheriting nodes',
    (key) => {
      for (const value of ['[1]', '[null]', '[""]', '[" "]']) {
        const defaults = factoryDefaults();
        defaults.settings[key] = value;
        defaults.settings.sniffing = false;
        expect(() => parseDefaults(defaults)).toThrow(/nonempty rule strings/);
      }
      const defaults = factoryDefaults();
      defaults.settings[key] = '[]';
      expect(parseDefaults(defaults).settings[key]).toBe('[]');
      defaults.settings[key] =
        key === 'domainsExcluded' ? '["full:example.net"]' : '["192.168.0.0/16"]';
      expect(parseDefaults(defaults).settings[key]).toBe(defaults.settings[key]);
    },
  );
});

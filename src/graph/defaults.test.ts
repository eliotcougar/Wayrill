/// <reference types="node" />
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
import { outboundPreview } from './outbounds';
import { compileDnsGraph } from './dnsCompilation';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph, toDocument, updateGraphNode } from './model';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  redoWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';

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

import { describe, expect, it } from 'vitest';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph, diagnoseXrayGraph } from './xrayCompiler';
import { nativeLiveFixture } from './nativeLiveFixture';
import { coreDefaultHint } from './coreDefaults';
import { getDefinition } from './catalog';
import { settingDefaultHint } from './defaults';

describe('review regressions', () => {
  it('reports imported listener collisions on both affected inbound nodes', () => {
    const config = nativeLiveFixture('noauth');
    const input = (config.inbounds as Record<string, unknown>[])[0];
    (config.inbounds as Record<string, unknown>[]).push({ ...input, tag: 'second' });
    const graph = importXrayConfig(JSON.stringify(config));
    const problems = diagnoseXrayGraph(graph).filter(
      (i) => i.severity === 'error' && i.message.includes('conflicts'),
    );
    expect(new Set(problems.map((p) => p.nodeId)).size).toBe(2);
  });
  it('normalizes equivalent IPv6 listener spellings before checking collisions', () => {
    const config = nativeLiveFixture('noauth'),
      input = (config.inbounds as Record<string, unknown>[])[0];
    input.listen = '::1';
    (config.inbounds as Record<string, unknown>[]).push({
      ...input,
      tag: 'second',
      listen: '0:0:0:0:0:0:0:1',
    });
    const graph = importXrayConfig(JSON.stringify(config));
    expect(diagnoseXrayGraph(graph).some((i) => i.message.includes('conflicts'))).toBe(true);
  });
  it('still reports listener collisions when another graph path is missing', () => {
    const config = nativeLiveFixture('noauth'),
      inputs = config.inbounds as Record<string, unknown>[];
    inputs.push({ ...inputs[0], tag: 'second' });
    const graph = importXrayConfig(JSON.stringify(config));
    graph.edges = [];
    expect(diagnoseXrayGraph(graph).filter((i) => i.message.includes('conflicts'))).toHaveLength(2);
  });
  it('allows metrics to share a numeric port with a different address or UDP socket', () => {
    for (const input of [
      { protocol: 'mixed', listen: '::1', settings: {} },
      {
        protocol: 'tunnel',
        listen: '127.0.0.1',
        settings: { address: '127.0.0.1', port: 18880, network: 'udp' },
      },
    ]) {
      const config = nativeLiveFixture('noauth');
      config.inbounds = [{ tag: 'local', port: 20921, ...input }];
      config.metrics = { listen: '127.0.0.1:20921' };
      config.routing = { rules: [] };
      const graph = importXrayConfig(JSON.stringify(config));
      expect(
        diagnoseXrayGraph(graph).some((i) => i.message.includes('Metrics can be exported')),
      ).toBe(false);
    }
  });
  it('detects native proxySettings and sockopt dial-through loops', () => {
    const config = nativeLiveFixture('noauth'),
      outputs = config.outbounds as Record<string, unknown>[];
    outputs[0].proxySettings = { tag: 'direct' };
    outputs[2].streamSettings = { sockopt: { dialerProxy: 'upstream' } };
    const graph = importXrayConfig(JSON.stringify(config));
    expect(
      diagnoseXrayGraph(graph).filter((i) => i.message.includes('outbound loop')),
    ).toHaveLength(2);
  });
  it('keeps omitted core settings unset in Global Defaults without changing exported JSON', () => {
    const config = { inbounds: [], outbounds: [{ tag: 'direct', protocol: 'freedom' }] };
    const graph = importXrayConfig(JSON.stringify(config));
    for (const key of [
      'logLevel',
      'dnsLog',
      'maskAddress',
      'routingDomainStrategy',
      'statistics',
      'policy',
      'metricsEnabled',
      'metricsTag',
      'metricsListen',
    ])
      expect(Object.hasOwn(graph.defaults!.settings, key)).toBe(false);
    expect(compileXrayGraph(graph).config).toEqual(config);
  });
  it('uses a DNS parent setting even when its native spelling differs', () => {
    expect(
      coreDefaultHint('NameServerConfig.disableCache', { parent: { DisableCache: true } }).text,
    ).toBe('Enabled');
  });
  it('uses the effective protocol transport for default hints', () => {
    const config = {
      outbounds: [
        {
          tag: 'vmess',
          protocol: 'vmess',
          settings: { address: '127.0.0.1', port: 20924, id: 'fictional' },
          streamSettings: { network: 'ws', security: 'tls' },
        },
      ],
    };
    const node = importXrayConfig(JSON.stringify(config)).nodes.find(
      (n) => n.data.kind === 'vmess-outbound',
    )!;
    const field = getDefinition(node.data.kind).fields.find((f) => f.key === 'alpn')!;
    expect(settingDefaultHint(node.data, field, undefined, config.outbounds[0])?.text).toBe(
      'http/1.1',
    );
  });
});

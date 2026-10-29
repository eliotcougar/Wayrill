/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import store from './xrayCoreDefaults.json';
import { coreDefaultHint } from './coreDefaults';
import {
  applyDefaults,
  enableDefaults,
  factoryDefaults,
  parseDefaults,
  resetCoreDefault,
} from './defaults';
import { createTrafficExample } from './example';
import { outboundPreview } from './outbounds';
import { inboundPreview } from './inbounds';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { fieldsForStructure } from './protocolFields';

const sample = () => enableDefaults(createTrafficExample());
const preferred = (g: ReturnType<typeof sample>) => g.nodes.find((n) => n.id === 'preferred')!;
describe('versioned Xray defaults and two-level inheritance', () => {
  it('does not fill absent globals with app factory values on parse or save', () => {
    const defaults = parseDefaults({ version: 1, settings: {} });
    expect(defaults.settings).toEqual({});
    const restored = parseGraph(serializeGraph(applyDefaults(sample(), defaults)));
    expect(restored.defaults?.settings).toEqual({});
    expect(preferred(restored).data.coreDefaults).toContain('xudpConcurrency');
  });
  it('omits inherited core defaults from emitted JSON and preserves configured false/zero', () => {
    let g = sample();
    const d = factoryDefaults();
    Object.assign(d.settings, { udp: false, tcpKeepAliveIdle: 0, xudpConcurrency: 0 });
    g = applyDefaults(g, d);
    expect(inboundPreview(g.nodes.find((n) => n.id === 'socks')!.data).settings).toHaveProperty(
      'udp',
      false,
    );
    expect(outboundPreview(preferred(g).data)).toMatchObject({
      streamSettings: { sockopt: { tcpKeepAliveIdle: 0 } },
    });
    g = applyDefaults(g, resetCoreDefault(d));
    const result = outboundPreview(preferred(g).data) as any;
    expect(result.streamSettings.sockopt).not.toHaveProperty('tcpKeepAliveIdle');
    expect(result.streamSettings.tlsSettings).not.toHaveProperty('fingerprint');
    expect(inboundPreview(g.nodes.find((n) => n.id === 'socks')!.data)).not.toHaveProperty(
      'sniffing',
    );
    expect(inboundPreview(g.nodes.find((n) => n.id === 'socks')!.data).settings).not.toHaveProperty(
      'udp',
    );
  });
  it('uses actual policy and transport defaults rather than old app presets', () => {
    expect(store.fields['TLSConfig.useSystemCA'].value).toBe(false);
    expect(coreDefaultHint('TLSConfig.useSystemCA').text).toContain('bundled CA');
    expect(coreDefaultHint('TLSConfig.certificates').text).toContain('Bundled CA');
    expect(
      coreDefaultHint('TLSConfig.certificates', {
        direction: 'outbound',
        object: { useSystemCA: true },
      }).text,
    ).toBe('Windows certificate store');
    expect(coreDefaultHint('MasqueConfig.path', { object: { warp: {} } }).text).toBe('/');
    expect(coreDefaultHint('MasqueConfig.path').text).toBe('/.well-known/masque/ip/*/*/');
    expect(
      coreDefaultHint('MasqueConfig.host', {
        direction: 'outbound',
        object: { warp: {} },
        root: { settings: { address: '198.51.100.1' } },
      }).text,
    ).toBe('cloudflareaccess.com');
    expect(coreDefaultHint('MasqueConfig.xmux').text).toContain('1800–3000');
    expect(fieldsForStructure('MasqueWarpConfig').find((f) => f.key === 'privateKey')?.secret).toBe(
      true,
    );
    expect(coreDefaultHint('Policy.handshake').text).toBe('60');
    expect(coreDefaultHint('Policy.uplinkOnly').text).toBe('1');
    expect(coreDefaultHint('KCPConfig.maxSendingWindow').text).toBe('2097152');
    expect(coreDefaultHint('WireGuardConfig.mtu').text).toBe('1420');
    expect(coreDefaultHint('XDriveConfig.concurrency').text).toBe('8');
    expect(coreDefaultHint('NameServerConfig.timeoutMs').text).toBe('4000');
  });
  it('resolves context-dependent TLS, listener timing and DNS inheritance', () => {
    expect(coreDefaultHint('TLSConfig.alpn', { network: 'ws' }).text).toBe('http/1.1');
    expect(
      coreDefaultHint('SocketConfig.tcpKeepAliveIdle', { direction: 'inbound' }).text,
    ).toContain('System timing');
    expect(
      coreDefaultHint('NameServerConfig.queryStrategy', { parent: { queryStrategy: 'UseIPv4' } })
        .text,
    ).toBe('UseIPv4');
    expect(
      coreDefaultHint('NameServerConfig.disableCache', { parent: { disableCache: false } }).text,
    ).toBe('Disabled');
    expect(coreDefaultHint('MasqueClientConfig.port').text).toContain('Required');
  });
});
const core = process.env.WAYRILL_XRAY_TEST_EXE,
  fixtures = process.env.WAYRILL_XRAY_FIXTURE_DIR;
describe.skipIf(!core || !fixtures)('configured core accepts inherited core defaults', () => {
  for (const transport of ['raw', 'xhttp', 'ws', 'grpc', 'kcp'])
    it(
      transport,
      () => {
        const g = applyDefaults(sample(), resetCoreDefault(factoryDefaults()));
        preferred(g).data.settings.network = transport;
        const config = compileRuntimeGraph(g).config;
        mkdirSync(fixtures!, { recursive: true });
        const file = join(fixtures!, `core-defaults-${transport}.json`);
        writeFileSync(file, JSON.stringify(config, null, 2));
        const result = spawnSync(core!, ['run', '-test', '-config', file], {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        });
        writeFileSync(file + '.log', String(result.stdout ?? '') + String(result.stderr ?? ''));
        expect(result.status, result.stdout + result.stderr).toBe(0);
      },
      15000,
    );
});

/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreDefaultHint, formatDefault } from './coreDefaults';
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
  it('keeps private protocol credentials marked as secret', () => {
    expect(fieldsForStructure('MasqueWarpConfig').find((f) => f.key === 'privateKey')?.secret).toBe(
      true,
    );
  });
  it('resolves transport ALPN and inherited DNS values', () => {
    expect(coreDefaultHint('TLSConfig.alpn', { network: 'ws' }).text).toBe('http/1.1');
    expect(
      coreDefaultHint('NameServerConfig.queryStrategy', { parent: { queryStrategy: 'UseIPv4' } })
        .text,
    ).toBe('UseIPv4');
    expect(
      coreDefaultHint('NameServerConfig.disableCache', { parent: { disableCache: false } }).text,
    ).toBe(formatDefault(false));
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

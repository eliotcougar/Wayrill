/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import store from './xrayCoreDefaults.json';
import { coreDefaultHint, embeddedCoreDefaults, globalDefaultHint } from './coreDefaults';
import {
  applyDefaults,
  enableDefaults,
  factoryDefaults,
  globalFields,
  overrideSetting,
  parseDefaults,
  resetNodeDefaults,
  resolveNodeData,
  resetCoreDefault,
} from './defaults';
import { createTrafficExample } from './example';
import { makeNode } from './catalog';
import { outboundPreview } from './outbounds';
import { inboundPreview } from './inbounds';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { protocolConfig } from './protocols';
import { protocolSource } from './protocolSource';
import { fieldsForStructure } from './protocolFields';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';

const sample = () => enableDefaults(createTrafficExample());
const preferred = (g: ReturnType<typeof sample>) => g.nodes.find((n) => n.id === 'preferred')!;
describe('versioned Xray defaults and two-level inheritance', () => {
  it('covers every global field and generated source field for the pinned binary', () => {
    expect(Object.keys(store.globals).sort()).toEqual(globalFields.map((f) => f.key).sort());
    for (const [structure, spec] of Object.entries(protocolSource))
      for (const field of spec.fields)
        expect(
          (store.fields as Record<string, unknown>)[`${structure}.${field.key}`],
        ).toBeDefined();
    expect(fieldsForStructure('KCPConfig').find((f) => f.key === 'maxSendingWindow')?.coreKey).toBe(
      'KCPConfig.maxSendingWindow',
    );
  });
  it('does not fill absent globals with app factory values on parse or save', () => {
    const defaults = parseDefaults({ version: 1, settings: {} });
    expect(defaults.settings).toEqual({});
    const restored = parseGraph(serializeGraph(applyDefaults(sample(), defaults)));
    expect(restored.defaults?.settings).toEqual({});
    expect(preferred(restored).data.coreDefaults).toContain('xudpConcurrency');
  });
  it('shows effective global values, core values and explicit false/zero correctly', () => {
    const defaults = factoryDefaults();
    defaults.settings.tcpKeepAliveIdle = 37;
    expect(globalDefaultHint('tcpKeepAliveIdle', defaults)).toMatchObject({
      text: '37',
      source: 'global',
    });
    expect(globalDefaultHint('udp', { version: 1, settings: { udp: false } })).toMatchObject({
      text: 'Disabled',
      source: 'global',
    });
    expect(
      globalDefaultHint('tcpKeepAliveIdle', { version: 1, settings: { tcpKeepAliveIdle: 0 } }),
    ).toMatchObject({ text: '0 → 45 seconds for outbound TCP', source: 'global' });
    expect(
      globalDefaultHint('tcpKeepAliveIdle', resetCoreDefault(defaults, 'tcpKeepAliveIdle')),
    ).toMatchObject({ text: '45 seconds for outbound TCP', source: 'core' });
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
  it('preserves node overrides when app settings are cleared, and can reapply core inheritance', () => {
    const defaults = resetCoreDefault(factoryDefaults());
    let data = resolveNodeData(makeNode('vless-outbound', { x: 0, y: 0 }).data, defaults);
    data = { ...data, ...overrideSetting(data, 'tcpKeepAliveIdle', 0) };
    data = resolveNodeData(data, defaults);
    expect(data.coreDefaults).not.toContain('tcpKeepAliveIdle');
    expect(outboundPreview(data)).toMatchObject({
      streamSettings: { sockopt: { tcpKeepAliveIdle: 0 } },
    });
    data = resetNodeDefaults(data, defaults, 'tcpKeepAliveIdle');
    expect(data.coreDefaults).toContain('tcpKeepAliveIdle');
    expect((outboundPreview(data).streamSettings as any).sockopt).not.toHaveProperty(
      'tcpKeepAliveIdle',
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
  it('retains advanced JSON as the configured value when a named global is unset', () => {
    const d = resetCoreDefault(factoryDefaults());
    d.settings.sockoptExtra = '{"tcpKeepAliveIdle":71}';
    const g = applyDefaults(sample(), d);
    expect(outboundPreview(preferred(g).data)).toMatchObject({
      streamSettings: { sockopt: { tcpKeepAliveIdle: 71 } },
    });
  });
  it('accounts for QUIC library Chrome emulation and transport-specific defaults', () => {
    expect(
      coreDefaultHint('QuicParamsConfig.initStreamReceiveWindow', {
        direction: 'outbound',
        network: 'hysteria',
      }).text,
    ).toBe('6291456 bytes');
    expect(
      coreDefaultHint('QuicParamsConfig.initStreamReceiveWindow', {
        direction: 'inbound',
        network: 'hysteria',
      }).text,
    ).toBe('8388608 bytes');
    expect(
      coreDefaultHint('QuicParamsConfig.maxIdleTimeout', {
        direction: 'outbound',
        network: 'xhttp',
      }).text,
    ).toBe('30 seconds');
    expect(
      coreDefaultHint('QuicParamsConfig.maxIdleTimeout', {
        direction: 'outbound',
        network: 'xhttp',
        root: { streamSettings: { finalmask: { quicParams: { disableChromeParrot: true } } } },
      }).text,
    ).toBe('300 seconds');
    expect(
      coreDefaultHint('QuicParamsConfig.maxIncomingStreams', {
        direction: 'outbound',
        network: 'masque',
      }).text,
    ).toContain('peer streams rejected');
  });
  it('does not confuse omitted imported native fields with app factory values', () => {
    const config = {
      inbounds: [{ tag: 'in', listen: '127.0.0.1', port: 2080, protocol: 'socks', settings: {} }],
      outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
    };
    const imported = importXrayConfig(JSON.stringify(config));
    expect(compileXrayGraph(imported).config).toEqual(config);
  });
  it('applies missing global settings to newly created source-defined protocols', () => {
    const d = resetCoreDefault(factoryDefaults()),
      node = makeNode('http-outbound', { x: 0, y: 0 });
    const data = resolveNodeData(node.data, d),
      raw = protocolConfig(data) as any;
    expect(raw.streamSettings?.sockopt ?? {}).not.toHaveProperty('tcpKeepAliveIdle');
    expect(raw).not.toHaveProperty('mux');
  });
  it('allows a core-default fragment packet selector but still requires lengths', () => {
    const d = resetCoreDefault(factoryDefaults());
    d.settings.fragmentEnabled = true;
    expect(() => parseDefaults(d)).toThrow(/fragment/i);
    d.settings.fragmentLengths = '50-100';
    expect(() => parseDefaults(d)).not.toThrow();
  });
  it('rejects a stale core pin or changed field catalogue at build time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wayrill-core-defaults-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      'tools/Check-CoreDefaults.mjs',
      'tools/core-defaults-audit.json',
      'service/dependencies.json',
      'src/graph/protocolSource.ts',
      'src/graph/xrayCoreDefaults.json',
      'src/graph/xrayConfigNames.json',
    ]) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      cpSync(join(process.cwd(), name), join(dir, name));
    }
    const run = () =>
      spawnSync(process.execPath, [join(dir, 'tools/Check-CoreDefaults.mjs')], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        env: { ...process.env, WAYRILL_XRAY_SOURCE: '' },
      });
    expect(run().status).toBe(0);
    const pin = JSON.parse(readFileSync(join(dir, 'service/dependencies.json'), 'utf8'));
    pin.xray.version = '99.1.1';
    writeFileSync(join(dir, 'service/dependencies.json'), JSON.stringify(pin));
    expect(run().stderr).toContain('review and regenerate');
    pin.xray.version = embeddedCoreDefaults.version;
    writeFileSync(join(dir, 'service/dependencies.json'), JSON.stringify(pin));
    const changedStore = structuredClone(store);
    changedStore.fields['Policy.handshake'].hint = '999';
    writeFileSync(join(dir, 'src/graph/xrayCoreDefaults.json'), JSON.stringify(changedStore));
    expect(run().stderr).toContain('differs from the reviewed audit');
    cpSync(
      join(process.cwd(), 'src/graph/xrayCoreDefaults.json'),
      join(dir, 'src/graph/xrayCoreDefaults.json'),
    );
    const namesPath = join(dir, 'src/graph/xrayConfigNames.json');
    const names = JSON.parse(readFileSync(namesPath, 'utf8'));
    const originalNames = readFileSync(namesPath, 'utf8');
    names.core.sourceCommit = 'unreviewed';
    writeFileSync(namesPath, JSON.stringify(names));
    expect(run().stderr).toContain('capitalization schema');
    writeFileSync(namesPath, originalNames);
    writeFileSync(join(dir, 'src/graph/protocolSource.ts'), '// changed source catalogue');
    expect(run().status).not.toBe(0);
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

import { describe, expect, it } from 'vitest';
import { getDefinition, makeNode } from './catalog';
import {
  applyDefaults,
  factoryDefaults,
  overrideSetting,
  resetNodeDefaults,
  resolveNodeData,
  settingDefaultState,
  resetCoreDefault,
} from './defaults';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph, xrayOutboundConfig, xrayInboundConfig } from './xrayCompiler';
import { parseGraph, serializeGraph } from './model';
import { parseNativeProjection } from './xrayProjection';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  undoWorkspaceHistory,
  redoWorkspaceHistory,
} from './workspaceHistory';
import type { RuleNodeData } from './types';

const config = (protocol = 'trojan', sockopt?: Record<string, unknown>) => ({
  inbounds: [{ tag: 'in', listen: '127.0.0.1', port: 2080, protocol: 'socks', settings: {} }],
  outbounds: [
    {
      tag: 'out',
      protocol,
      settings:
        protocol === 'trojan'
          ? { servers: [{ address: 'public.example', port: 443, password: 'public-fixture' }] }
          : {},
      ...(protocol === 'trojan' || sockopt
        ? {
            streamSettings: {
              ...(protocol === 'trojan'
                ? { network: 'raw', security: 'tls', tlsSettings: { serverName: 'public.example' } }
                : {}),
              ...(sockopt ? { sockopt } : {}),
            },
          }
        : {}),
    },
  ],
});
const field = (data: RuleNodeData, key: string) =>
  getDefinition(data.kind).fields.find((f) => f.key === key)!;
const state = (data: RuleNodeData, key: string, defaults = factoryDefaults()) =>
  settingDefaultState(data, field(data, key), defaults, xrayOutboundConfig(data));
describe('default provenance and explicit intent', () => {
  it('follows app defaults, including false and zero, and distinguishes blank from a configured value', () => {
    const defaults = factoryDefaults(),
      data = resolveNodeData(makeNode('vless-outbound', { x: 0, y: 0 }).data, defaults);
    expect(state(data, 'tcpKeepAliveIdle', defaults)).toMatchObject({
      label: 'App default',
      inherited: true,
      independent: false,
      hint: { text: '0 → 45 seconds for outbound TCP', source: 'global' },
    });
    expect(state(data, 'muxEnabled', defaults).hint).toMatchObject({
      text: 'Disabled',
      source: 'global',
    });
    defaults.settings.fingerprint = '';
    expect(state(resolveNodeData(data, defaults), 'fingerprint', defaults).label).toBe(
      'Xray default',
    );
  });
  it('uses contextual core hints when the graph default is absent', () => {
    const defaults = resetCoreDefault(factoryDefaults(), 'tcpKeepAliveIdle'),
      data = resolveNodeData(makeNode('vless-outbound', { x: 0, y: 0 }).data, defaults);
    expect(state(data, 'tcpKeepAliveIdle', defaults)).toMatchObject({
      label: 'Xray default',
      inherited: true,
      hint: { text: '45 seconds for outbound TCP' },
    });
  });
  it('freezes an inherited value equal to the current app default across later default changes', () => {
    const defaults = factoryDefaults();
    defaults.settings.tcpKeepAliveIdle = 30;
    let data = resolveNodeData(makeNode('vless-outbound', { x: 0, y: 0 }).data, defaults);
    data = { ...data, ...overrideSetting(data, 'tcpKeepAliveIdle', 30) };
    defaults.settings.tcpKeepAliveIdle = 60;
    data = resolveNodeData(data, defaults);
    expect(data.settings.tcpKeepAliveIdle).toBe(30);
    expect(state(data, 'tcpKeepAliveIdle', defaults)).toMatchObject({
      label: 'Overridden',
      resetHint: { text: '60', source: 'global' },
    });
    expect(resetNodeDefaults(data, defaults, 'tcpKeepAliveIdle').settings.tcpKeepAliveIdle).toBe(
      60,
    );
  });
  it('keeps an imported omission blank and describes the reset target without applying it', () => {
    const native = config(),
      graph = importXrayConfig(JSON.stringify(native)),
      node = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!;
    graph.defaults!.settings.tcpKeepAliveIdle = 30;
    expect(state(node.data, 'tcpKeepAliveIdle', graph.defaults)).toMatchObject({
      label: 'Imported omission',
      independent: true,
      inherited: true,
      hint: { text: '45 seconds for outbound TCP', source: 'core' },
      resetHint: { text: '30', source: 'global' },
    });
    expect(compileXrayGraph(graph).config).toEqual(native);
    node.data = resetNodeDefaults(node.data, graph.defaults!, 'tcpKeepAliveIdle');
    expect((xrayOutboundConfig(node.data).streamSettings as any).sockopt.tcpKeepAliveIdle).toBe(30);
  });
  it.each(['trojan', 'freedom'])(
    'retains an explicit zero edit of an imported omission for %s through save/reload',
    (protocol) => {
      const graph = importXrayConfig(JSON.stringify(config(protocol))),
        node = graph.nodes.find(
          (n) => n.data.kind === (protocol === 'trojan' ? 'trojan-outbound' : 'direct-outbound'),
        )!;
      node.data = { ...node.data, ...overrideSetting(node.data, 'tcpKeepAliveIdle', 0) };
      expect(state(node.data, 'tcpKeepAliveIdle', graph.defaults)).toMatchObject({
        label: 'Overridden',
        inherited: false,
        effectiveText: '0 → 45 seconds for outbound TCP',
      });
      const saved = parseGraph(serializeGraph(graph)),
        raw = compileXrayGraph(saved).config.outbounds as any[];
      expect(raw[0].streamSettings.sockopt.tcpKeepAliveIdle).toBe(0);
      expect(raw[0].streamSettings.sockopt).not.toHaveProperty('tcpKeepAliveInterval');
      const reset = resetNodeDefaults(
        saved.nodes.find((n) => n.id === node.id)!.data,
        resetCoreDefault(graph.defaults!, 'tcpKeepAliveIdle'),
        'tcpKeepAliveIdle',
      );
      expect((xrayOutboundConfig(reset).streamSettings as any)?.sockopt ?? {}).not.toHaveProperty(
        'tcpKeepAliveIdle',
      );
      expect(reset.native?.editedKeys).not.toContain('tcpKeepAliveIdle');
    },
  );
  it.each([0, 45])(
    'identifies imported explicit %s without confusing equality with inheritance',
    (value) => {
      const graph = importXrayConfig(JSON.stringify(config('trojan', { tcpKeepAliveIdle: value }))),
        node = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!;
      const defaults = factoryDefaults();
      defaults.settings.tcpKeepAliveIdle = value;
      const updated = applyDefaults(graph, defaults),
        data = updated.nodes.find((n) => n.id === node.id)!.data;
      expect(state(data, 'tcpKeepAliveIdle', defaults)).toMatchObject({
        label: 'Imported value',
        inherited: false,
        independent: true,
      });
      defaults.settings.tcpKeepAliveIdle = 90;
      expect(resolveNodeData(data, defaults).settings.tcpKeepAliveIdle).toBe(value);
    },
  );
  it('does not turn an imported false into inheritance', () => {
    const native = {
        ...config(),
        outbounds: [{ ...config().outbounds[0], mux: { enabled: false } }],
      },
      graph = importXrayConfig(JSON.stringify(native)),
      data = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!.data;
    expect(state(data, 'muxEnabled', graph.defaults)).toMatchObject({
      label: 'Imported value',
      inherited: false,
    });
    expect(compileXrayGraph(graph).config).toEqual(native);
  });
  it('identifies an advanced node value when the named app default is absent', () => {
    const defaults = resetCoreDefault(factoryDefaults(), 'tcpKeepAliveIdle');
    let data = makeNode('vless-outbound', { x: 0, y: 0 }).data;
    data = { ...data, ...overrideSetting(data, 'sockoptExtra', '{"tcpKeepAliveIdle":71}') };
    data = resolveNodeData(data, defaults);
    expect(state(data, 'tcpKeepAliveIdle', defaults).hint).toMatchObject({
      text: '71',
      source: 'native',
    });
  });
  it('keeps inherited core omission when freezing a different field and resetting all edits', () => {
    const native = config(),
      graph = importXrayConfig(JSON.stringify(native)),
      node = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!;
    node.data = { ...node.data, ...overrideSetting(node.data, 'tcpKeepAliveIdle', 0) };
    const reset = resetNodeDefaults(node.data, resetCoreDefault(factoryDefaults()));
    expect(reset.native?.editedKeys).toEqual([]);
    expect((xrayOutboundConfig(reset).streamSettings as any).sockopt ?? {}).not.toHaveProperty(
      'tcpKeepAliveIdle',
    );
  });
  it.each([
    ['tcpKeepAliveIdle', 'tcpKeepAliveIdle'],
    ['muxEnabled', 'muxEnabled'],
  ])('rejects duplicate explicit intent keys: %s', (a, b) => {
    expect(() =>
      parseNativeProjection({ version: 1, original: {}, projection: {}, editedKeys: [a, b] }),
    ).toThrow(/inheritance baseline/);
  });
  it('does not flatten per-account values into a single invented default', () => {
    const graph = importXrayConfig(JSON.stringify(config())),
      data = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!.data;
    expect(state(data, 'userLevel', graph.defaults)).toMatchObject({
      label: 'Native account settings',
      inherited: true,
      hint: { source: 'native' },
    });
  });
  it('keeps an imported listener omission distinct from explicitly disabled UDP', () => {
    const native = config(),
      graph = importXrayConfig(JSON.stringify(native)),
      node = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
    const display = (data: RuleNodeData) =>
      settingDefaultState(data, field(data, 'udp'), graph.defaults, xrayInboundConfig(data));
    expect(display(node.data)).toMatchObject({
      label: 'Imported omission',
      inherited: true,
      hint: { text: 'Disabled' },
    });
    node.data = { ...node.data, ...overrideSetting(node.data, 'udp', false) };
    expect(display(node.data)).toMatchObject({ label: 'Overridden', inherited: false });
    const reloaded = parseGraph(serializeGraph(graph)),
      raw = (compileXrayGraph(reloaded).config.inbounds as any[])[0];
    expect(raw.settings.udp).toBe(false);
    expect(raw).not.toHaveProperty('sniffing');
    expect(raw.listen).toBe('127.0.0.1');
  });
  it('does not label an unrelated advanced override as the source of an inherited app option', () => {
    const defaults = resetCoreDefault(factoryDefaults(), 'tcpKeepAliveIdle');
    defaults.settings.sockoptExtra = '{"tcpKeepAliveIdle":71}';
    let data = makeNode('vless-outbound', { x: 0, y: 0 }).data;
    data = { ...data, ...overrideSetting(data, 'tlsExtra', '{"serverName":"public.example"}') };
    data = resolveNodeData(data, defaults);
    expect(state(data, 'tcpKeepAliveIdle', defaults).hint).toMatchObject({
      text: '71',
      source: 'global',
    });
  });
  it('keeps equal-value override intent undoable even when the visible value is unchanged', () => {
    const graph = importXrayConfig(JSON.stringify(config())),
      node = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!;
    const changed = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n === node
          ? { ...n, data: { ...n.data, ...overrideSetting(n.data, 'tcpKeepAliveIdle', 0) } }
          : n,
      ),
    };
    let history = commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: changed });
    expect(history.past).toHaveLength(1);
    history = undoWorkspaceHistory(history);
    expect(compileXrayGraph(history.present.graph).config).toEqual(config());
    history = redoWorkspaceHistory(history);
    expect(
      (compileXrayGraph(history.present.graph).config.outbounds as any[])[0].streamSettings.sockopt
        .tcpKeepAliveIdle,
    ).toBe(0);
  });
  it('does not display encoded policy-level zero as an imported configured value', () => {
    const graph = importXrayConfig(
        JSON.stringify({ outbounds: [{ tag: 'out', protocol: 'freedom', settings: {} }] }),
      ),
      data = graph.nodes.find((n) => n.data.kind === 'direct-outbound')!.data;
    expect(state(data, 'userLevel', graph.defaults)).toMatchObject({
      label: 'Imported omission',
      inherited: true,
      hint: { text: '0' },
    });
  });
  it('distinguishes a blank named app default from removing it when advanced JSON supplies a value', () => {
    const defaults = factoryDefaults();
    defaults.settings.fingerprint = '';
    defaults.settings.tlsExtra = '{"fingerprint":"firefox"}';
    let data = resolveNodeData(makeNode('vless-outbound', { x: 0, y: 0 }).data, defaults);
    expect(state(data, 'fingerprint', defaults)).toMatchObject({
      label: 'Xray default',
      inherited: true,
      hint: { text: 'chrome', source: 'core' },
    });
    const absent = resetCoreDefault(defaults, 'fingerprint');
    data = resolveNodeData(data, absent);
    expect(state(data, 'fingerprint', absent).hint).toMatchObject({
      text: 'firefox',
      source: 'global',
    });
  });
});

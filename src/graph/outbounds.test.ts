import { describe, expect, it } from 'vitest';
import { getDefinition, getOutputPorts, makeNode, uniqueOutboundTag } from './catalog';
import { createRoutingExample } from './example';
import { diagnoseGraph, parseGraph, serializeGraph, toDocument } from './model';
import { outboundPreview, outboundProblems, validVlessEncryption, validVlessId } from './outbounds';
import { fieldProblem, isFieldVisible } from './settingValidation';
import type { NodeKind } from './types';

function configured(kind: NodeKind = 'vless-outbound') {
  const node = makeNode(kind, { x: 0, y: 0 }, 'outbound');
  if (kind === 'vless-outbound')
    Object.assign(node.data.settings, {
      address: 'server.example.net',
      id: 'd9eead44-7056-42fe-b3bf-24f5c1d457ae',
    });
  return node;
}
function errors(node: ReturnType<typeof configured>) {
  return diagnoseGraph({ name: 'Test', nodes: [node], edges: [] }).filter(
    (issue) => issue.severity === 'error',
  );
}
const key = 'A'.repeat(43); // Dummy 32-byte Base64URL key, never a real credential.

describe('outbound configuration', () => {
  it('creates three distinct terminal nodes and diagnoses missing credentials', () => {
    for (const kind of ['vless-outbound', 'direct-outbound', 'block-outbound'] as const)
      expect(getOutputPorts(kind)).toEqual(kind === 'block-outbound' ? [] : ['observation']);
    const empty = makeNode('vless-outbound', { x: 0, y: 0 });
    expect(errors(empty).map((issue) => issue.fieldKey)).toEqual(
      expect.arrayContaining(['address', 'id']),
    );
    expect(errors(configured())).toEqual([]);
    expect(errors(configured('direct-outbound'))).toEqual([]);
    expect(errors(configured('block-outbound'))).toEqual([]);
  });
  it('validates UTF-8 ID length as Xray does, including non-canonical hex UUIDs', () => {
    expect(validVlessId('friendly-name')).toBe(true);
    expect(validVlessId('я'.repeat(15))).toBe(true);
    expect(validVlessId('я'.repeat(16))).toBe(false);
    expect(validVlessId('d9eead44705642feb3bf24f5c1d457ae')).toBe(true);
    expect(validVlessId('d9eead44-7056-42fe-b3bf-24f5c1d457ae')).toBe(true);
    expect(validVlessId('z'.repeat(36))).toBe(false);
    expect(validVlessId('')).toBe(false);
  });
  it('accepts current VLESS encryption syntax and rejects unsupported values', () => {
    expect(validVlessEncryption('none')).toBe(true);
    expect(validVlessEncryption(`mlkem768x25519plus.native.1rtt.${key}`)).toBe(true);
    expect(validVlessEncryption(`mlkem768x25519plus.random.0rtt.${key}`)).toBe(true);
    expect(validVlessEncryption(`mlkem768x25519plus.bad.1rtt.${key}`)).toBe(false);
    expect(validVlessEncryption('auto')).toBe(false);
    expect(validVlessEncryption('mlkem768x25519plus.native.2rtt.invalid')).toBe(false);
  });
  it('switches visible fields without dropping settings from saved documents', () => {
    const node = configured();
    Object.assign(node.data.settings, {
      network: 'ws',
      host: 'ws.example.net',
      path: '/socket',
      security: 'reality',
      realityPassword: key,
      shortId: 'ab12',
    });
    const fields = getDefinition(node.data.kind).fields;
    expect(
      isFieldVisible(
        fields.find((field) => field.key === 'path')!,
        node.data.settings,
      ),
    ).toBe(true);
    expect(
      isFieldVisible(
        fields.find((field) => field.key === 'grpcAuthority')!,
        node.data.settings,
      ),
    ).toBe(false);
    node.data.settings.network = 'grpc';
    node.data.settings.security = 'tls';
    const restored = parseGraph(serializeGraph({ name: 'Modes', nodes: [node], edges: [] }))
      .nodes[0];
    expect(restored.data.settings).toMatchObject({
      host: 'ws.example.net',
      path: '/socket',
      realityPassword: key,
      shortId: 'ab12',
    });
    expect(
      isFieldVisible(
        fields.find((field) => field.key === 'realityPassword')!,
        restored.data.settings,
      ),
    ).toBe(false);
  });
  it('checks REALITY transport, key length, short ID and spider path', () => {
    const node = configured();
    Object.assign(node.data.settings, {
      security: 'reality',
      realityPassword: key,
      serverName: 'www.example.net',
      shortId: 'ab12',
      flow: 'xtls-rprx-vision',
    });
    expect(errors(node)).toEqual([]);
    node.data.settings.network = 'ws';
    expect(errors(node).some((issue) => issue.fieldKey === 'security')).toBe(true);
    Object.assign(node.data.settings, {
      network: 'raw',
      realityPassword: 'bad',
      shortId: 'a',
      spiderX: 'wrong',
    });
    expect(errors(node).map((issue) => issue.fieldKey)).toEqual(
      expect.arrayContaining(['realityPassword', 'shortId', 'spiderX']),
    );
  });
  it('checks Vision TCP mux, TLS versions and pins', () => {
    const node = configured();
    Object.assign(node.data.settings, { flow: 'xtls-rprx-vision', muxEnabled: true });
    expect(errors(node).some((issue) => issue.fieldKey === 'muxConcurrency')).toBe(true);
    node.data.settings.muxConcurrency = -1;
    expect(errors(node)).toEqual([]);
    Object.assign(node.data.settings, {
      tlsMinVersion: '1.3',
      tlsMaxVersion: '1.2',
      pinnedPeerCertSha256: 'abc',
    });
    expect(errors(node).map((issue) => issue.fieldKey)).toEqual(
      expect.arrayContaining(['tlsMaxVersion', 'pinnedPeerCertSha256']),
    );
    Object.assign(node.data.settings, {
      tlsMinVersion: '',
      tlsMaxVersion: '',
      pinnedPeerCertSha256: 'AA:'.repeat(31) + 'AA',
    });
    expect(errors(node)).toEqual([]);
  });
  it('allows incomplete drafts to round-trip and diagnoses active JSON only', () => {
    const node = configured();
    Object.assign(node.data.settings, {
      network: 'xhttp',
      xhttpExtra: '{',
      certificates: '{}',
      security: 'reality',
      realityPassword: key,
    });
    expect(errors(node).some((issue) => issue.fieldKey === 'xhttpExtra')).toBe(true);
    expect(errors(node).some((issue) => issue.fieldKey === 'certificates')).toBe(false);
    const restored = parseGraph(serializeGraph({ name: 'Draft', nodes: [node], edges: [] }))
      .nodes[0];
    expect(restored.data.settings.xhttpExtra).toBe('{');
    restored.data.settings.network = 'raw';
    expect(errors(restored).some((issue) => issue.fieldKey === 'xhttpExtra')).toBe(false);
  });
  it('rejects wrong JSON shapes, invalid header maps and fractional ports', () => {
    const node = configured();
    const fields = getDefinition(node.data.kind).fields;
    Object.assign(node.data.settings, {
      network: 'ws',
      headers: '{"Host":"example.net","Other":3}',
      port: 443.5,
    });
    expect(errors(node).map((issue) => issue.fieldKey)).toEqual(
      expect.arrayContaining(['headers', 'port']),
    );
    node.data.settings.headers = '[]';
    expect(
      fieldProblem(
        fields.find((field) => field.key === 'headers')!,
        node.data.settings,
      ),
    ).toMatch(/JSON object/);
    expect(() =>
      parseGraph(serializeGraph({ name: 'Bad port', nodes: [node], edges: [] })),
    ).toThrow(/port/i);
  });
  it('validates Direct redirects and custom Block bytes', () => {
    const direct = configured('direct-outbound');
    direct.data.settings.redirect = '[::1]:443';
    expect(errors(direct)).toEqual([]);
    direct.data.settings.redirect = 'server:70000';
    expect(errors(direct).some((issue) => issue.fieldKey === 'redirect')).toBe(true);
    const block = configured('block-outbound');
    Object.assign(block.data.settings, { response: 'custom', customResponseData: 'SGVsbG8=' });
    expect(errors(block)).toEqual([]);
    block.data.settings.customResponseData = 'bad!';
    expect(errors(block).some((issue) => issue.fieldKey === 'customResponseData')).toBe(true);
  });
  it('produces current per-node JSON for TLS, REALITY, Direct and Block', () => {
    const vless = configured();
    expect(outboundPreview(vless.data)).toMatchObject({
      protocol: 'vless',
      settings: { address: 'server.example.net', encryption: 'none', id: vless.data.settings.id },
      streamSettings: { network: 'raw', security: 'tls' },
    });
    Object.assign(vless.data.settings, {
      security: 'reality',
      realityPassword: key,
      shortId: 'abcd',
    });
    const preview = outboundPreview(vless.data) as { streamSettings: Record<string, unknown> };
    expect(preview.streamSettings).not.toHaveProperty('tlsSettings');
    expect(preview.streamSettings.realitySettings).toMatchObject({
      password: key,
      shortId: 'abcd',
    });
    expect(outboundPreview(configured('direct-outbound').data)).toMatchObject({
      protocol: 'freedom',
      streamSettings: { sockopt: { domainStrategy: 'AsIs' } },
    });
    expect(outboundPreview(configured('block-outbound').data)).toEqual({
      tag: 'block',
      protocol: 'blackhole',
      settings: { response: { type: 'none' } },
    });
  });
  it('preserves nested XHTTP extra and FinalMask and omits inactive modes from previews', () => {
    const node = configured();
    Object.assign(node.data.settings, {
      network: 'xhttp',
      xhttpExtra:
        '{"xmux":{"maxConnections":"2-4"},"downloadSettings":{"network":"raw","security":"tls"}}',
      finalmask:
        '{"tcp":[{"type":"fragment","settings":{"packets":"tlshello","length":"100-200","interval":"1-2"}}]}',
      rawHeader: '{',
    });
    const preview = outboundPreview(node.data) as { streamSettings: Record<string, unknown> };
    expect(preview.streamSettings.xhttpSettings).toMatchObject({
      extra: { xmux: { maxConnections: '2-4' }, downloadSettings: { network: 'raw' } },
    });
    expect(preview.streamSettings).not.toHaveProperty('rawSettings');
    const restored = parseGraph(serializeGraph({ name: 'Nested', nodes: [node], edges: [] }))
      .nodes[0];
    expect(restored.data.settings).toEqual(node.data.settings);
  });
  it('rejects a malformed Block definition missing its required tag', () => {
    const raw = toDocument(createRoutingExample());
    raw.nodes.find((node) => node.id === 'block')!.data.settings = { response: 'none' };
    expect(() => parseGraph(JSON.stringify(raw))).toThrow(/tag/i);
  });
  it('finds unused tags and diagnoses duplicate tags and dial-through cycles', () => {
    const first = configured();
    const second = { ...configured('direct-outbound'), id: 'second' };
    expect(uniqueOutboundTag('vless', [first])).toBe('vless-2');
    Object.assign(second.data.settings, { tag: 'vless' });
    expect(
      diagnoseGraph({ name: 'Duplicates', nodes: [first, second], edges: [] }).some(
        (issue) => issue.fieldKey === 'tag',
      ),
    ).toBe(true);
    Object.assign(second.data.settings, { tag: 'direct', dialerProxy: 'vless' });
    first.data.settings.dialerProxy = 'direct';
    expect(
      diagnoseGraph({ name: 'Cycle', nodes: [first, second], edges: [] }).filter(
        (issue) => issue.fieldKey === 'dialerProxy',
      ),
    ).toHaveLength(2);
  });
  it('keeps removed TLS options out of valid previews', () => {
    const node = configured();
    node.data.settings.tlsExtra = '{"allowInsecure":true}';
    expect(outboundProblems(node.data).some((issue) => issue.fieldKey === 'tlsExtra')).toBe(true);
  });
});

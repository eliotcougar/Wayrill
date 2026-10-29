import { describe, expect, it } from 'vitest';
import { getDefinition, makeNode, uniqueOutboundTag } from './catalog';
import { diagnoseGraph, parseGraph, serializeGraph } from './model';
import { outboundPreview, validVlessEncryption } from './outbounds';
import { fieldProblem } from './settingValidation';
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
  it('accepts current VLESS encryption syntax and rejects unsupported values', () => {
    expect(validVlessEncryption('none')).toBe(true);
    expect(validVlessEncryption(`mlkem768x25519plus.native.1rtt.${key}`)).toBe(true);
    expect(validVlessEncryption(`mlkem768x25519plus.random.0rtt.${key}`)).toBe(true);
    expect(validVlessEncryption(`mlkem768x25519plus.bad.1rtt.${key}`)).toBe(false);
    expect(validVlessEncryption('auto')).toBe(false);
    expect(validVlessEncryption('mlkem768x25519plus.native.2rtt.invalid')).toBe(false);
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
});

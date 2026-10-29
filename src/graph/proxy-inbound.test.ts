/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { makeNode, makeProxyInbound } from './catalog';
import { factoryDefaults, resolveGraph } from './defaults';
import { inboundPreview, inboundPreFilters } from './inbounds';
import { importXrayConfig } from './xrayImport';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';

const modes = ['socks', 'http', 'mixed'] as const;
const graphFor = (mode: (typeof modes)[number]) => {
  const input = makeProxyInbound(mode, { x: 0, y: 0 }, 'proxy');
  const direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
  return resolveGraph({
    name: 'Proxy modes',
    defaults: factoryDefaults(),
    nodes: [input, direct],
    edges: ['data', 'dns'].map((port) => ({
      id: port,
      source: input.id,
      sourceHandle: port,
      target: direct.id,
      targetHandle: 'in',
    })),
  });
};
const native = (mode: (typeof modes)[number], settings: Record<string, unknown> = {}) => ({
  inbounds: [{ tag: 'native', protocol: mode, listen: '127.0.0.1', port: 20801, settings }],
  outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
  routing: { rules: [] },
});

describe('One Proxy inbound with three modes', () => {
  it.each(modes)('%s emits its native protocol with the same graph connections', (mode) => {
    const graph = graphFor(mode),
      before = structuredClone(graph.edges);
    const config = compileRuntimeGraph(graph).config;
    expect((config.inbounds as Record<string, unknown>[])[0].protocol).toBe(mode);
    expect(parseGraph(serializeGraph(graph)).nodes[0].data.settings.mode).toBe(mode);
    expect(graph.edges).toEqual(before);
    expect(inboundPreFilters(graph.nodes[0].data)[0].match.network).toBe(
      mode === 'http' ? 'tcp' : 'tcp,udp',
    );
  });
  it('selects the correct account field and leaves no inactive authentication/UDP fields', () => {
    for (const mode of modes) {
      const input = makeProxyInbound(mode, { x: 0, y: 0 });
      Object.assign(input.data.settings, {
        auth: 'password',
        username: 'qa',
        password: 'example-only',
      });
      const settings = inboundPreview(input.data).settings as Record<string, unknown>;
      expect(settings[mode === 'socks' ? 'users' : 'accounts']).toEqual([
        { user: 'qa', pass: 'example-only' },
      ]);
      if (mode === 'http') {
        expect(settings).not.toHaveProperty('auth');
        expect(settings).not.toHaveProperty('udp');
      }
    }
  });
  it.each(modes)(
    'native %s switching modes removes old protocol settings without losing metadata',
    (mode) => {
      const original = native(
        mode,
        mode === 'http'
          ? { accounts: [{ user: 'qa', pass: 'one' }], allowTransparent: true }
          : { auth: 'password', udp: true, ip: '127.0.0.1', users: [{ user: 'qa', pass: 'one' }] },
      );
      const graph = importXrayConfig(JSON.stringify(original)),
        input = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
      const oldId = input.id,
        edges = structuredClone(graph.edges),
        oldTag = input.data.settings.tag;
      for (const next of modes) {
        input.data.settings.mode = next;
        const config = compileRuntimeGraph(graph).config,
          raw = (config.inbounds as Record<string, unknown>[])[0];
        expect(raw.protocol).toBe(next);
        expect(raw.tag).toBe(oldTag);
        expect(input.id).toBe(oldId);
        expect(graph.edges).toEqual(edges);
        if (next === 'http') {
          expect(raw.settings).not.toHaveProperty('udp');
          expect(raw.settings).not.toHaveProperty('ip');
          expect(raw.settings).not.toHaveProperty('auth');
        } else if (next !== mode) {
          expect(raw.settings).not.toHaveProperty('allowTransparent');
        }
      }
      input.data.settings.mode = mode;
      expect(compileRuntimeGraph(graph).config).toEqual(original);
    },
  );
});

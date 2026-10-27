/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDefinition, makeNode, makeProxyInbound } from './catalog';
import { factoryDefaults, resolveGraph, resetNodeDefaults, resetCoreDefault } from './defaults';
import { inboundPreview, inboundProblems, inboundPreFilters } from './inbounds';
import { fieldProblem, isFieldVisible } from './settingValidation';
import { importXrayConfig } from './xrayImport';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { xrayInboundConfig } from './xrayCompiler';

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
  it('HTTP retains but hides UDP drafts and excludes them from diagnostics and config', () => {
    const input = makeProxyInbound('http', { x: 0, y: 0 });
    Object.assign(input.data.settings, { udp: true, udpAddress: 'bad retained draft' });
    for (const key of ['udp', 'udpAddress'])
      expect(
        isFieldVisible(
          getDefinition(input.data.kind).fields.find((f) => f.key === key)!,
          input.data.settings,
        ),
      ).toBe(false);
    expect(inboundProblems(input.data).some((i) => i.fieldKey === 'udpAddress')).toBe(false);
    expect(inboundPreview(input.data).settings).not.toHaveProperty('udp');
    expect(inboundPreview(input.data).settings).not.toHaveProperty('ip');
    input.data.settings.mode = 'socks';
    expect(inboundProblems(input.data).some((i) => i.fieldKey === 'udpAddress')).toBe(true);
  });
  it('HTTP credentials are not subject to the SOCKS5 byte limit', () => {
    const input = makeProxyInbound('http', { x: 0, y: 0 });
    Object.assign(input.data.settings, {
      auth: 'password',
      username: 'name',
      password: 'a'.repeat(300),
    });
    expect(inboundProblems(input.data).filter((i) => i.severity === 'error')).toEqual([]);
    input.data.settings.mode = 'mixed';
    expect(inboundProblems(input.data).some((i) => i.fieldKey === 'password')).toBe(true);
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
  it('reapplies UDP defaults across modes without changing listener identity', () => {
    const graph = graphFor('http'),
      input = graph.nodes[0];
    input.data.overrides = ['udp'];
    input.data.settings.udp = false;
    const reset = resetNodeDefaults(input.data, graph.defaults!, 'udp');
    expect(reset.settings.udp).toBe(true);
    expect(reset.settings.mode).toBe('http');
    expect(inboundPreview(reset).settings).not.toHaveProperty('udp');
    expect(
      inboundPreview({ ...reset, settings: { ...reset.settings, mode: 'socks' } }).settings,
    ).toHaveProperty('udp', true);
    const core = resolveGraph({
      ...graph,
      defaults: resetCoreDefault(graph.defaults!, 'udp'),
      nodes: [
        { ...input, data: { ...reset, settings: { ...reset.settings, mode: 'mixed' } } },
        graph.nodes[1],
      ],
    });
    expect(inboundPreview(core.nodes[0].data).settings).not.toHaveProperty('udp');
  });
  it('exposes and edits native transparent HTTP only in HTTP mode', () => {
    const graph = importXrayConfig(JSON.stringify(native('http', { allowTransparent: true }))),
      input = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
    expect(input.data.settings.allowTransparent).toBe(true);
    input.data.settings.allowTransparent = false;
    expect(xrayInboundConfig(input.data).settings).toHaveProperty('allowTransparent', false);
    input.data.settings.mode = 'socks';
    expect(xrayInboundConfig(input.data).settings).not.toHaveProperty('allowTransparent');
  });
  it('rejects an unknown mode', () => {
    const input = makeNode('proxy-inbound', { x: 0, y: 0 });
    input.data.settings.mode = 'unknown';
    expect(
      fieldProblem(
        getDefinition(input.data.kind).fields.find((f) => f.key === 'mode')!,
        input.data.settings,
      ),
    ).toBeTruthy();
    const graph = graphFor('mixed');
    graph.nodes[0].data.settings.mode = 'unknown';
    expect(() => parseGraph(serializeGraph(graph))).toThrow();
  });
  for (const mode of modes)
    for (const accountKey of ['users', 'accounts']) {
      it(`${mode} native ${accountKey} import stays identical through storage and account edits`, () => {
        const settings = {
          ...(mode !== 'http' ? { auth: 'password', udp: false } : {}),
          [accountKey]: [{ user: 'qa', pass: 'one' }],
          userLevel: 3,
        };
        const original = native(mode, settings),
          graph = parseGraph(serializeGraph(importXrayConfig(JSON.stringify(original))));
        const input = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
        expect(input.data.settings.mode).toBe(mode);
        expect(compileRuntimeGraph(graph).config).toEqual(original);
        input.data.settings.password = 'two';
        const edited = xrayInboundConfig(input.data).settings as Record<string, unknown>;
        expect(edited[accountKey]).toEqual([{ user: 'qa', pass: 'two' }]);
        expect(edited).not.toHaveProperty(accountKey === 'users' ? 'accounts' : 'users');
      });
    }
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
  const core = process.env.WAYRILL_XRAY_TEST_EXE,
    dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
  for (const mode of modes)
    it.skipIf(!core || !dir)(`${mode} generated config passes the pinned core`, () => {
      mkdirSync(dir!, { recursive: true });
      const file = join(dir!, `unified-proxy-${mode}.json`);
      writeFileSync(file, JSON.stringify(compileRuntimeGraph(graphFor(mode)).config));
      const result = spawnSync(core!, ['run', '-test', '-c', file], {
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    });
});

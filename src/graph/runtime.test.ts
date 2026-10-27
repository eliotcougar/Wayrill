/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNode, makeProxyInbound, getOutputPorts } from './catalog';
import { createTrafficExample } from './example';
import { inboundPreview } from './inbounds';
import { parseGraph, serializeGraph } from './model';
import { readRuleTable, tableSettings } from './rules';
import { compileRuntimeGraph } from './runtime';

const example = () => createTrafficExample();
const core = process.env.WAYRILL_XRAY_TEST_EXE,
  fixtureDir = process.env.WAYRILL_XRAY_FIXTURE_DIR;

describe('Complete graph runtime compilation', () => {
  it('preserves scoped ordered rules, DNS transport priority and an explicit blocked fallback', () => {
    const graph = example(),
      result = compileRuntimeGraph(parseGraph(serializeGraph(graph)));
    const config = result.config as {
      inbounds: Record<string, unknown>[];
      outbounds: Record<string, unknown>[];
      routing: { rules: Record<string, unknown>[] };
    };
    expect(config.inbounds.map((i) => i.protocol)).toEqual(['socks', 'http']);
    expect(config.outbounds[0]).toMatchObject({
      tag: 'wayrill-runtime-unmatched',
      protocol: 'blackhole',
    });
    const rules = config.routing.rules;
    expect(rules[0]).toMatchObject({
      inboundTag: ['wayrill-dns-local-dns-lan'],
      outboundTag: 'direct',
    });
    expect(rules[1]).toMatchObject({
      inboundTag: ['wayrill-dns-remote-dns-cloudflare'],
      outboundTag: 'preferred',
    });
    expect(rules.slice(2, 4).map((r) => r.port)).toEqual(['53', '53']);
    expect(rules.slice(4, 8).map((r) => r.outboundTag)).toEqual([
      'block',
      'direct',
      'direct',
      'preferred',
    ]);
    expect(rules.slice(4, 8).every((r) => JSON.stringify(r.inboundTag) === '["local-socks"]')).toBe(
      true,
    );
    expect(rules.slice(8).every((r) => JSON.stringify(r.inboundTag) === '["local-http"]')).toBe(
      true,
    );
    expect(result.summary).toMatchObject({
      dnsServerCount: 2,
      trafficRuleCount: 12,
      outboundCount: 5,
    });
    expect(result.warnings).toEqual([]);
  });
  it('compiles an HTTP listener with real basic-auth accounts and TCP-only DNS classification', () => {
    const graph = example(),
      http = graph.nodes.find((n) => n.id === 'http')!;
    Object.assign(http.data.settings, {
      auth: 'password',
      username: 'first',
      password: 'test-only',
      extraAccounts: '[{"user":"second","pass":"test-two"}]',
    });
    expect(inboundPreview(http.data)).toMatchObject({
      protocol: 'http',
      settings: {
        allowTransparent: false,
        accounts: [
          { user: 'first', pass: 'test-only' },
          { user: 'second', pass: 'test-two' },
        ],
      },
    });
    expect(inboundPreview(http.data).settings).not.toHaveProperty('udp');
    expect(getOutputPorts('proxy-inbound')).toEqual(['data', 'dns']);
    const config = compileRuntimeGraph(graph).config as {
      routing: { rules: Record<string, unknown>[] };
    };
    expect(config.routing.rules[3]).toMatchObject({ network: 'tcp', port: '53' });
  });
  it('does not override an ANDed inbound-tag condition with another graph scope', () => {
    const graph = example(),
      filter = graph.nodes.find((n) => n.id === 'routes')!,
      table = readRuleTable(filter.data.settings);
    table.rules[0].conditions.inboundTag = 'local-http';
    Object.assign(filter.data.settings, tableSettings(table));
    const config = compileRuntimeGraph(graph).config as {
      routing: { rules: Record<string, unknown>[] };
    };
    expect(config.routing.rules.filter((r) => r.outboundTag === 'block')).toEqual([
      expect.objectContaining({ inboundTag: ['local-http'] }),
    ]);
  });
  it('requires each input branch and each enabled/default output to be connected', () => {
    for (const id of ['http-data', 'http-dns', 'routes-vless', 'routes-block']) {
      const graph = example();
      graph.edges = graph.edges.filter((e) => e.id !== id);
      expect(() => compileRuntimeGraph(graph)).toThrow(/Connect/);
    }
  });
  it('retains disabled drafts without requiring their unused output paths', () => {
    const graph = example(),
      filter = graph.nodes.find((n) => n.id === 'routes')!,
      table = readRuleTable(filter.data.settings);
    table.rules[0].enabled = false;
    table.rules[0].conditions.port = 'invalid';
    table.rules[0].conditions.process = 'browser.exe';
    Object.assign(filter.data.settings, tableSettings(table));
    graph.edges = graph.edges.filter((e) => e.id !== 'routes-block');
    expect(() => compileRuntimeGraph(graph)).not.toThrow();
  });
  it('rejects design placeholders, incomplete chains and compiles native process metadata', () => {
    const legacy = example();
    legacy.nodes.push(makeNode('xray-options', { x: 0, y: 0 }, 'app'));
    expect(() => compileRuntimeGraph(legacy)).toThrow(/cannot run yet/);
    const chain = example(),
      second = makeNode('routing-filter', { x: 0, y: 0 }, 'second');
    chain.nodes.push(second);
    chain.edges.find((e) => e.id === 'routes-vless')!.target = second.id;
    expect(() => compileRuntimeGraph(chain)).toThrow(/Connect the default/);
    const process = example(),
      filter = process.nodes.find((n) => n.id === 'routes')!,
      table = readRuleTable(filter.data.settings);
    table.rules[0].conditions.process = 'browser.exe';
    Object.assign(filter.data.settings, tableSettings(table));
    expect(
      (
        compileRuntimeGraph(process).config.routing as { rules: Record<string, unknown>[] }
      ).rules.some((r) => Array.isArray(r.process) && r.process.includes('browser.exe')),
    ).toBe(true);
  });
  it('preserves public IPs, wildcard IPs and low ports in executable configs', () => {
    for (const listen of ['0.0.0.0', '::', '192.0.2.1', '2001:db8::1', '127.0.0.2', 'localhost']) {
      for (const port of [1, 53, 80, 443, 1023, 65535]) {
        const graph = example(),
          input = graph.nodes.find((n) => n.id === 'socks')!;
        Object.assign(input.data.settings, { listen, port });
        expect(
          (compileRuntimeGraph(graph).config.inbounds as Record<string, unknown>[])[0],
        ).toMatchObject({ listen: listen === 'localhost' ? '127.0.0.1' : listen, port });
      }
    }
  });
  it('rejects overlapping wildcard sockets after localhost normalization', () => {
    const graph = example(),
      input = graph.nodes.find((n) => n.id === 'socks')!;
    Object.assign(input.data.settings, { listen: '0.0.0.0', port: 2081 });
    expect(() => compileRuntimeGraph(graph)).toThrow(/another inbound uses/);
    input.data.settings.listen = '::';
    expect(() => compileRuntimeGraph(graph)).toThrow(/another inbound uses/);
  });
  it('rejects missing dial-through destinations, DNS tag collisions and reserved tags', () => {
    const graph = example(),
      vless = graph.nodes.find((n) => n.id === 'preferred')!;
    vless.data.settings.dialerProxy = 'missing';
    expect(() => compileRuntimeGraph(graph)).toThrow(/[Dd]efine.*dial-through/);
    vless.data.settings.dialerProxy = '';
    vless.data.settings.tag = String(graph.nodes.find((n) => n.id === 'dns')!.data.settings.tag);
    expect(() => compileRuntimeGraph(graph)).toThrow(/including the DNS handler/);
    vless.data.settings.tag = 'wayrill-runtime-unmatched';
    expect(() => compileRuntimeGraph(graph)).toThrow(/reserved/);
  });
  it('supports a minimal direct-only graph without a global DNS module', () => {
    const input = makeProxyInbound('socks', { x: 0, y: 0 }, 'socks'),
      direct = makeNode('direct-outbound', { x: 0, y: 0 }, 'direct');
    const result = compileRuntimeGraph({
      name: 'Direct',
      nodes: [input, direct],
      edges: ['dns', 'data'].map((port) => ({
        id: port,
        source: 'socks',
        sourceHandle: port,
        target: 'direct',
        targetHandle: 'in',
      })),
    });
    expect(result.config).not.toHaveProperty('dns');
    expect(result.summary.trafficRuleCount).toBe(2);
  });
});

describe.skipIf(!core || !fixtureDir)('Complete runtime configured Xray compatibility', () => {
  for (const name of ['runtime-xhttp-tls', 'runtime-raw-reality', 'runtime-http-auth'])
    it(name, () => {
      const graph = example();
      if (name === 'runtime-raw-reality')
        Object.assign(graph.nodes.find((n) => n.id === 'preferred')!.data.settings, {
          network: 'raw',
          security: 'reality',
          realityPassword: 'A'.repeat(43),
          serverName: 'www.example.net',
          shortId: 'ab12',
          flow: 'xtls-rprx-vision',
        });
      if (name === 'runtime-http-auth')
        Object.assign(graph.nodes.find((n) => n.id === 'http')!.data.settings, {
          auth: 'password',
          username: 'qa',
          password: 'test-only',
        });
      const compiled = compileRuntimeGraph(graph);
      mkdirSync(fixtureDir!, { recursive: true });
      const file = join(fixtureDir!, `${name}.json`);
      writeFileSync(file, JSON.stringify(compiled.config, null, 2));
      if (name === 'runtime-xhttp-tls')
        writeFileSync(
          join(fixtureDir!, 'first-traffic-example.wayrill.json'),
          serializeGraph(graph),
        );
      const result = spawnSync(core!, ['run', '-test', '-config', file], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      writeFileSync(
        join(fixtureDir!, `${name}.log`),
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Configuration OK.');
    });
});

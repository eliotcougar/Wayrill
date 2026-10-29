/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { makeNode, makeProxyInbound } from './catalog';
import { createTrafficExample } from './example';
import { parseGraph, serializeGraph } from './model';
import { readRuleTable, tableSettings } from './rules';
import { compileRuntimeGraph } from './runtime';

const example = () => createTrafficExample();

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

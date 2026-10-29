/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { makeNode, getOutputPorts } from './catalog';
import { compileFakeDnsPools, editFakeDnsGraph, fakeDnsConfigProblems } from './fakeDns';
import { createFakeDnsExample } from './fakeDnsExample';
import { compileRuntimeGraph } from './runtime';
import { compileDnsGraph } from './dnsCompilation';
import { parseGraph, serializeGraph } from './model';

describe('FakeDNS pools and resolver graph', () => {
  it('keeps automatic pools implicit and supplies a real DNS path behind synthetic answers', () => {
    const graph = createFakeDnsExample(),
      compiled = compileRuntimeGraph(graph);
    expect(compiled.config).not.toHaveProperty('fakedns');
    expect((compiled.config.dns as { servers: unknown[] }).servers).toEqual([
      { address: 'fakedns', domains: ['regexp:.*'], skipFallback: true, finalQuery: false },
      expect.objectContaining({ address: '1.1.1.1', skipFallback: false }),
    ]);
    expect(getOutputPorts('fakedns')).toEqual([]);
    expect(parseGraph(serializeGraph(graph)).nodes.map((n) => n.data.kind)).toContain('fakedns');
    expect(compiled.warnings).not.toContainEqual(expect.stringContaining('no inbound'));
    expect(compiled.config.routing).toEqual(
      expect.objectContaining({
        rules: expect.arrayContaining([
          expect.objectContaining({
            inboundTag: expect.arrayContaining([expect.stringMatching(/^wayrill-dns-/)]),
          }),
        ]),
      }),
    );
  });
  it('shares custom pool edits atomically between resolver instances', () => {
    const graph = createFakeDnsExample();
    graph.nodes.push(makeNode('fakedns', { x: 800, y: 700 }, 'second'));
    const settings = {
      ...graph.nodes.find((n) => n.data.kind === 'fakedns')!.data.settings,
      pools: '{"ipPool":"198.18.0.0/24","poolSize":200}',
    };
    const next = editFakeDnsGraph(graph, 'fake-resolver', settings);
    expect(
      next.nodes.filter((n) => n.data.kind === 'fakedns').map((n) => n.data.settings.pools),
    ).toEqual([settings.pools, settings.pools]);
    expect(compileFakeDnsPools(next)).toEqual({ ipPool: '198.18.0.0/24', poolSize: 200 });
    expect(graph.nodes.find((n) => n.id === 'second')!.data.settings.pools).toBe('');
    expect(compileDnsGraph(next).fakedns).toEqual({ ipPool: '198.18.0.0/24', poolSize: 200 });
  });
  it('recovers fake destinations even with routeOnly and warns when recovery is absent', () => {
    const config = compileRuntimeGraph(createFakeDnsExample()).config;
    expect(fakeDnsConfigProblems(config)).toEqual([]);
    (config.inbounds as Record<string, unknown>[])[0].sniffing = {
      enabled: false,
      destOverride: ['fakedns'],
    };
    expect(fakeDnsConfigProblems(config)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('no inbound'),
      }),
    );
    delete config.dns;
    (config.inbounds as Record<string, unknown>[])[0].sniffing = {
      enabled: true,
      destOverride: ['fakedns'],
      routeOnly: true,
    };
    expect(fakeDnsConfigProblems(config)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('inactive'),
      }),
    );
  });
});

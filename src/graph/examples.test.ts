/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledExamples, createProxyStarter } from './examples';
import { diagnoseRuntimeGraph } from './diagnostics';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { structureProblems } from './structure';
import { capturesSystemDns } from './dnsCapture';
import { jsonArray, jsonRecord } from './xrayJson';
import { isInboundKind } from './inbounds';

const configFor = (id: string) =>
  compileRuntimeGraph(bundledExamples.find((example) => example.id === id)!.create()).config;
const records = (value: unknown) => (jsonArray(value) ? value.filter(jsonRecord) : []);

describe('Shipped example configurations', () => {
  it.each(bundledExamples)(
    '$label has complete, compatible paths and survives saving',
    (example) => {
      const graph = example.create();
      const errors = diagnoseRuntimeGraph(graph).filter((issue) => issue.severity === 'error');
      expect(errors, JSON.stringify(errors)).toEqual([]);
      expect(structureProblems(graph)).toEqual([]);
      const config = compileRuntimeGraph(graph).config;
      expect(compileRuntimeGraph(parseGraph(serializeGraph(graph))).config).toEqual(config);
      const text = JSON.stringify(graph);
      expect(text).not.toMatch(
        /10\.0\.2\.3|127\.0\.0\.1:1888[012]|Schematic verification|VM NAT DNS/,
      );
      for (const outbound of records(config.outbounds))
        expect(outbound.settings).not.toHaveProperty('redirect');
    },
  );

  it('opens a useful first graph without importing credentials or configuring Windows', () => {
    const graph = createProxyStarter();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.mainOutboundId).toBe('direct');
    expect(compileRuntimeGraph(graph).config).toMatchObject({
      inbounds: [{ protocol: 'mixed', listen: '127.0.0.1', port: 10808 }],
    });
    expect(
      records(compileRuntimeGraph(graph).config.outbounds).filter(
        (outbound) => outbound.protocol === 'vless',
      ),
    ).toEqual([]);
    graph.nodes[0].data.settings.port = 9999;
    expect(createProxyStarter().nodes[0].data.settings.port).toBe(10808);
  });

  it.each(bundledExamples.filter((example) => example.category === 'starter'))(
    '$label is self-contained and has one capture/listener source',
    (example) => {
      const graph = example.create();
      expect(graph.nodes.filter((node) => isInboundKind(node.data.kind))).toHaveLength(1);
      expect(
        graph.nodes.some((node) =>
          ['vless-outbound', 'proxy-chain', 'policy-group'].includes(node.data.kind),
        ),
      ).toBe(false);
      expect(graph.nodes.filter((node) => node.data.kind === 'direct-outbound')).toHaveLength(1);
    },
  );

  it('sends example.org to Quad9 and retains a real Cloudflare fallback', () => {
    const config = configFor('dns');
    const dns = config.dns as Record<string, unknown>;
    expect(records(dns.servers)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: '9.9.9.9',
          domains: ['domain:example.org'],
          skipFallback: true,
          finalQuery: true,
        }),
        expect.objectContaining({ address: 'https://1.1.1.1/dns-query', skipFallback: false }),
      ]),
    );
  });

  it('captures system DNS for FakeDNS, enables recovery and keeps real lookup fallback', () => {
    const graph = bundledExamples.find((example) => example.id === 'fakedns')!.create();
    expect(capturesSystemDns(graph, 'fake-handler')).toBe(true);
    const config = compileRuntimeGraph(graph).config;
    expect(records(config.inbounds)).toContainEqual(
      expect.objectContaining({
        protocol: 'tun',
        sniffing: expect.objectContaining({
          enabled: true,
          destOverride: expect.arrayContaining(['fakedns']),
        }),
      }),
    );
    const servers = records((config.dns as Record<string, unknown>).servers);
    expect(servers[0]).toMatchObject({ address: 'fakedns', skipFallback: true, finalQuery: false });
    expect(servers.slice(1)).toContainEqual(
      expect.objectContaining({ address: '1.1.1.1', skipFallback: false }),
    );
  });

  it('observes both manual policy candidates and fails closed when none is usable', () => {
    const config = configFor('policy');
    expect(config.observatory).toMatchObject({
      subjectSelector: ['server-a', 'server-b'],
      probeURL: 'https://cp.cloudflare.com/generate_204',
    });
    expect((config.routing as Record<string, unknown>).balancers).toEqual([
      expect.objectContaining({
        selector: ['server-a', 'server-b'],
        fallbackTag: 'block',
        strategy: { type: 'leastPing' },
      }),
    ]);
  });

  it('compiles chain order from this PC through A, then B', () => {
    const config = configFor('chain');
    const outbounds = records(config.outbounds);
    const exit = outbounds.find((outbound) => outbound.tag === 'main')!;
    expect(exit).toMatchObject({ protocol: 'vless', settings: { address: '192.0.2.2' } });
    const carrier = (exit.streamSettings as { sockopt: { dialerProxy: string } }).sockopt
      .dialerProxy;
    expect(outbounds.find((outbound) => outbound.tag === carrier)).toMatchObject({
      protocol: 'vless',
      settings: { address: '192.0.2.1' },
    });
  });

  it('flattens child destination rules with their parent port guard', () => {
    const rules = records((configFor('chained').routing as Record<string, unknown>).rules);
    expect(rules).toContainEqual(
      expect.objectContaining({
        domain: ['full:example.com'],
        port: '80,443',
        outboundTag: 'block',
      }),
    );
    expect(
      rules.filter((rule) => JSON.stringify(rule.domain) === JSON.stringify(['full:example.com'])),
    ).toHaveLength(1);
  });

  const executable = process.env.WAYRILL_XRAY_TEST_EXE;
  const directory = process.env.WAYRILL_XRAY_FIXTURE_DIR;
  it.skipIf(!executable || !directory).each(bundledExamples)(
    '$label is accepted by the packaged Xray core',
    (example) => {
      mkdirSync(directory!, { recursive: true });
      const path = join(directory!, `${example.id}.json`);
      writeFileSync(path, JSON.stringify(compileRuntimeGraph(example.create()).config, null, 2));
      const result = spawnSync(executable!, ['run', '-test', '-format', 'json', '-config', path], {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );
});

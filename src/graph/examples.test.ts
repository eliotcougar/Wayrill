/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { diagnoseRuntimeGraph } from './diagnostics';
import { capturesSystemDns } from './dnsCapture';
import { bundledExamples } from './examples';
import { parseGraph, serializeGraph } from './model';
import { compileRuntimeGraph } from './runtime';
import { structureProblems } from './structure';
import { jsonArray, jsonRecord } from './xrayJson';

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
});

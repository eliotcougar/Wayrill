/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledExamples } from './examples';
import { diagnoseRuntimeGraph } from './diagnostics';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { structureProblems } from './structure';
import { capturesSystemDns } from './dnsCapture';
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

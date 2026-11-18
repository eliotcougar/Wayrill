/// <reference types="node" />
import { expect, it } from 'vitest';
import { capturesSystemDns } from './dnsCapture';
import { bundledExamples } from './examples';
import { parseGraph, serializeGraph } from './model';
import { compileRuntimeGraph } from './runtime';
import { jsonArray, jsonRecord } from './xrayJson';

const records = (value: unknown) => (jsonArray(value) ? value.filter(jsonRecord) : []);

it('runs the local proxy starter after reopening it without requiring a DNS handler', () => {
  const starter = bundledExamples.find((entry) => entry.id === 'proxy')!.create();
  const { config } = compileRuntimeGraph(parseGraph(serializeGraph(starter)));
  expect(config).not.toHaveProperty('dns');
  const direct = records(config.outbounds).find((outbound) => outbound.protocol === 'freedom')!;
  const rules = records((config.routing as Record<string, unknown>).rules);
  expect(rules).toContainEqual(
    expect.objectContaining({ inboundTag: ['local-proxy'], outboundTag: direct.tag }),
  );
  expect(rules.every((rule) => rule.outboundTag === direct.tag)).toBe(true);
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
    expect.objectContaining({
      address: expect.stringMatching(/^(?!fakedns$).+/),
      skipFallback: false,
    }),
  );
});

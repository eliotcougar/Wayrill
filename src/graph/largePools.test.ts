import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LIMITS } from '../limits';
import { createPolicyExample } from './policyExample';
import { createChainedExample } from './chainedExample';
import {
  policyCandidates,
  emptyPolicySources,
  policyProfileId,
  type PolicyProfile,
} from './policySources';
import { compileRuntimeGraph } from './runtime';
import { compileXrayGraph } from './xrayCompiler';
import { importXrayConfig } from './xrayImport';
import { parseGraph, serializeGraph } from './model';

function profiles(count: number): PolicyProfile[] {
  return Array.from({ length: count }, (_, i) => {
    const profile = {
      kind: 'vless-outbound' as const,
      settings: {
        address: `edge-${i}.example.net`,
        port: 443,
        id: 'qa-fictional',
        security: 'tls',
        network: 'xhttp',
        serverName: 'example.net',
      },
    };
    return { type: 'profile', name: `Region ${i}`, profile, id: policyProfileId(profile) };
  });
}
function groupGraph(count: number) {
  const graph = createPolicyExample('roundRobin');
  graph.nodes = graph.nodes.filter((n) => n.data.kind !== 'observatory');
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'observation');
  Object.assign(graph.nodes.find((n) => n.data.kind === 'policy-group')!.data.settings, {
    observe: false,
    fallbackEnabled: false,
    selection: 'manual',
    sources: JSON.stringify({ ...emptyPolicySources(), manual: profiles(count) }),
  });
  return graph;
}
it('preserves the ordered native config while keeping 5,000 imported candidates off the canvas', () => {
  const config = {
    inbounds: [
      { tag: 'client', listen: '127.0.0.1', port: 20901, protocol: 'mixed', settings: {} },
    ],
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      ...Array.from({ length: 5000 }, (_, i) => ({
        tag: `edge-${i}`,
        protocol: 'socks',
        settings: { address: '127.0.0.1', port: 21901, user: `qa-${i}`, pass: 'public-only' },
        proxySettings: { tag: 'direct' },
      })),
    ],
    routing: {
      rules: [{ port: '443', balancerTag: 'region' }],
      balancers: [{ tag: 'region', selector: ['edge-'], strategy: { type: 'roundRobin' } }],
    },
  };
  const graph = importXrayConfig(JSON.stringify(config));
  expect(graph.nodes.length).toBeLessThan(10);
  expect(graph.xray!.outboundPool).toHaveLength(5000);
  expect(
    policyCandidates(
      graph,
      graph.nodes.find((n) => n.data.kind === 'policy-group')!,
    ),
  ).toHaveLength(5000);
  expect(compileXrayGraph(parseGraph(serializeGraph(graph))).config).toEqual(config);
  graph.nodes.find((n) => n.data.settings.tag === 'direct')!.data.settings.tag = 'renamed';
  const edited = compileXrayGraph(graph).config.outbounds as {
    tag: string;
    proxySettings?: { tag: string };
  }[];
  expect(edited[0].tag).toBe('renamed');
  expect(edited.slice(1).every((o) => o.proxySettings?.tag === 'renamed')).toBe(true);
});
it('measures substantial compiled subscriptions with compact, exact selectors', () => {
  const dir = process.env.WAYRILL_POOL_FIXTURE_DIR,
    measurements = [];
  for (const count of [1000, 5000, LIMITS.maxOutbounds - 4]) {
    const start = performance.now(),
      graph = groupGraph(count),
      built = performance.now(),
      compiled = compileRuntimeGraph(graph),
      elapsed = performance.now() - built;
    const config = compiled.config,
      outputs = config.outbounds as { tag: string }[],
      selectors = (config.routing as { balancers: { selector: string[] }[] }).balancers[0].selector;
    expect(outputs).toHaveLength(count + 4);
    expect(outputs.filter((o) => selectors.some((p) => o.tag.startsWith(p)))).toHaveLength(count);
    expect(selectors.length).toBeLessThan(32);
    const json = JSON.stringify(config);
    expect(new TextEncoder().encode(json).length).toBeLessThan(LIMITS.configBytes);
    measurements.push({
      count,
      prepareMs: built - start,
      compileMs: elapsed,
      bytes: Buffer.byteLength(json),
      selectorCount: selectors.length,
      nodes: graph.nodes.length,
    });
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `compiled-pool-${count}.xray.json`), json);
    }
  }
  if (dir) writeFileSync(join(dir, 'compiler-sizing.json'), JSON.stringify(measurements, null, 2));
}, 20000);
it('enforces the total core-outbound limit including generated fallbacks', () => {
  expect(() => compileRuntimeGraph(groupGraph(LIMITS.maxOutbounds - 3))).toThrow(
    /16,384 outbounds/,
  );
}, 15000);
it('retains exact membership for overlapping substantial groups and generated aliases', () => {
  const graph = groupGraph(200),
    first = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  const all = profiles(300),
    sources = emptyPolicySources();
  sources.manual = [{ type: 'node', nodeId: 'test-first' }, ...all.slice(0, 200)];
  first.data.settings.sources = JSON.stringify(sources);
  const second = structuredClone(first);
  second.id = 'second-group';
  second.data.settings.tag = 'other-group';
  second.data.settings.sources = JSON.stringify({
    ...emptyPolicySources(),
    manual: [{ type: 'node', nodeId: 'test-first' }, ...all.slice(100)],
  });
  const extra = structuredClone(graph.nodes.find((n) => n.id === 'test-second')!);
  extra.id = 'prefix-collision';
  extra.data.settings.tag = 'test-a-extra';
  graph.nodes.push(second, extra);
  const config = compileRuntimeGraph(graph).config,
    outputs = config.outbounds as { tag: string }[];
  const groups = (config.routing as { balancers: { selector: string[] }[] }).balancers;
  const alias = 'wayrill-policy-member-10-test-first';
  for (const [i, group] of groups.entries()) {
    const expected = new Set([
      alias,
      ...all
        .slice(i === 0 ? 0 : 100, i === 0 ? 200 : 300)
        .map((p) => `wayrill-policy-profile-${p.id}`),
    ]);
    expect(
      new Set(
        outputs.filter((o) => group.selector.some((p) => o.tag.startsWith(p))).map((o) => o.tag),
      ),
    ).toEqual(expected);
  }
});

it('builds executable loopback fixtures with substantial internal manual candidate sets', () => {
  const dir = process.env.WAYRILL_POOL_FIXTURE_DIR;
  for (const count of [5000, LIMITS.maxOutbounds - 4]) {
    const native = {
      log: { loglevel: 'warning' },
      inbounds: [
        { tag: 'client', listen: '127.0.0.1', port: 20911, protocol: 'mixed', settings: {} },
      ],
      outbounds: [
        { tag: 'blocked', protocol: 'blackhole' },
        ...Array.from({ length: count }, (_, i) => ({
          tag: `pool-${String(i).padStart(5, '0')}`,
          protocol: 'socks',
          settings: {
            address: '127.0.0.1',
            port: 21901,
            user: `candidate-${i}`,
            pass: 'public-qa-only',
          },
        })),
      ],
      routing: {
        rules: [{ network: 'tcp', balancerTag: 'pool' }],
        balancers: [{ tag: 'pool', selector: ['pool-'], strategy: { type: 'roundRobin' } }],
      },
    };
    const graph = importXrayConfig(JSON.stringify(native));
    const group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
    group.data.settings.selection = 'manual';
    group.data.settings.sources = JSON.stringify({
      ...emptyPolicySources(),
      manual: graph.xray!.outboundPool!.map((entry) => ({ type: 'node', nodeId: entry.id })),
    });
    const config = compileXrayGraph(graph).config;
    expect(config.outbounds).toHaveLength(count + 1);
    expect(
      (config.routing as { balancers: { selector: string[] }[] }).balancers[0].selector,
    ).toEqual(['p']);
    expect(graph.nodes.length).toBeLessThan(10);
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `executable-pool-${count}.xray.json`), JSON.stringify(config));
      writeFileSync(join(dir, `executable-pool-${count}.wayrill.json`), serializeGraph(graph));
    }
  }
  const chained = createChainedExample();
  chained.nodes = chained.nodes.filter((node) => node.data.kind !== 'observatory');
  chained.edges = chained.edges.filter((edge) => edge.sourceHandle !== 'observation');
  Object.assign(chained.nodes.find((node) => node.data.kind === 'policy-group')!.data.settings, {
    observe: false,
    fallbackEnabled: false,
  });
  const config = compileRuntimeGraph(chained).config;
  if (dir) writeFileSync(join(dir, 'executable-chained.xray.json'), JSON.stringify(config));
}, 20000);

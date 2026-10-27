import { expect, it } from 'vitest';
import { createChainedExample } from './chainedExample';
import { compileRuntimeGraph } from './runtime';
import { compileXrayGraph } from './xrayCompiler';
import { importXrayConfig } from './xrayImport';
import { tableSettings, readRuleTable } from './rules';
import { makeNode } from './catalog';
import { copyRoutingTrace, getRoutingTrace, setRoutingTrace } from './routingTrace';
import { factoryDefaults } from './defaults';
import type { GraphState } from './types';

it('keeps both matched filters and fallbacks beside flattened config, not inside it', () => {
  const graph = createChainedExample();
  const compiled = compileRuntimeGraph(graph);
  const trails = Object.values(compiled.displayNames!.routing!);
  expect(trails.some((t) => t.map((h) => h.rule).join(' / ') === 'Web / Example domains')).toBe(
    true,
  );
  expect(trails.some((t) => t.map((h) => h.rule).join(' / ') === 'Web / Unmatched traffic')).toBe(
    true,
  );
  expect(trails.some((t) => t[0].rule === 'Unmatched traffic')).toBe(true);
  const exported = JSON.stringify(compiled.config);
  expect(exported).not.toContain('filterId');
  expect(exported).not.toContain('wr-route-');
  expect(exported).not.toContain('Web');
});
it('retains imported native rule tags and identifies implicit default without changing JSON', () => {
  const config = {
    inbounds: [{ tag: 'input', protocol: 'socks', listen: '127.0.0.1', port: 10808, settings: {} }],
    outbounds: [
      { tag: 'direct', protocol: 'freedom', settings: {} },
      { tag: 'block', protocol: 'blackhole', settings: {} },
    ],
    routing: {
      rules: [
        {
          type: 'field',
          ruleTag: 'user tag',
          domain: ['full:blocked.example'],
          outboundTag: 'block',
        },
      ],
    },
  };
  const graph = importXrayConfig(JSON.stringify(config));
  const compiled = compileXrayGraph(graph);
  const rules = (compiled.config.routing as { rules: Record<string, unknown>[] }).rules;
  expect(rules[0].ruleTag).toBe('user tag');
  expect(rules).toHaveLength(1);
  expect(compiled.displayNames?.routing?.['0']?.[0].ruleId).toBeTruthy();
  expect(compiled.displayNames?.routingDefault?.[0].rule).toBe('Unmatched traffic');
});
it('keeps process-rule metadata on projected capture and ordinary input rules', () => {
  const input = makeNode('proxy-inbound', { x: 0, y: 0 });
  const capture = makeNode('windivert-inbound', { x: 0, y: 100 });
  const filter = makeNode('routing-filter', { x: 300, y: 0 });
  const direct = makeNode('direct-outbound', { x: 600, y: 0 });
  const table = readRuleTable(filter.data.settings);
  filter.data.settings = {
    ...filter.data.settings,
    ...tableSettings({
      ...table,
      rules: [
        {
          id: 'browser',
          name: 'Browser family',
          enabled: true,
          matchAll: false,
          output: table.defaultOutput,
          conditions: { process: 'browser.exe' },
          applications: [
            { enabled: true, kind: 'process', mode: 'name', value: 'browser.exe', children: true },
          ],
        },
      ],
    }),
  };
  const graph = {
    name: 'Capture projection',
    defaults: factoryDefaults(),
    nodes: [input, capture, filter, direct],
    edges: [
      { id: 'data', source: input.id, sourceHandle: 'data', target: filter.id, targetHandle: 'in' },
      { id: 'dns', source: input.id, sourceHandle: 'dns', target: direct.id, targetHandle: 'in' },
      {
        id: 'capture',
        source: capture.id,
        sourceHandle: 'data',
        target: filter.id,
        targetHandle: 'in',
      },
      {
        id: 'capture-dns',
        source: capture.id,
        sourceHandle: 'dns',
        target: direct.id,
        targetHandle: 'in',
      },
      {
        id: 'out',
        source: filter.id,
        sourceHandle: table.defaultOutput,
        target: direct.id,
        targetHandle: 'in',
      },
    ],
  } as GraphState;
  const result = compileRuntimeGraph(graph);
  const matches = Object.values(result.displayNames!.routing!).filter(
    (t) => t[0].ruleId === 'browser',
  );
  expect(matches.length).toBeGreaterThanOrEqual(2);
  expect(matches.every((t) => t[0].filterId === filter.id)).toBe(true);
});
it('metadata clones do not alter enumerable config fields', () => {
  const original = setRoutingTrace({ outboundTag: 'direct' }, [
    { filterId: 'f', ruleId: null, rule: 'Unmatched traffic', outputId: 'out', output: 'Direct' },
  ]);
  const clone = copyRoutingTrace(original, { ...original, inboundTag: ['tun'] });
  expect(getRoutingTrace(clone)).toEqual(getRoutingTrace(original));
  expect(JSON.parse(JSON.stringify(clone))).toEqual({ outboundTag: 'direct', inboundTag: ['tun'] });
});

import { expect, it } from 'vitest';
import { createChainedExample } from './chainedExample';
import { compileRuntimeGraph } from './runtime';
import { makeNode } from './catalog';
import { displayNames } from './displayNames';

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
  expect(exported).not.toContain('wrr-');
  expect(exported).not.toContain('Web');
});

it('retains DNS handler and virtual policy names with the applied revision', () => {
  const graph = createChainedExample();
  const handler = makeNode('dns-handler', { x: 0, y: 0 }, 'dns');
  const group = makeNode('policy-group', { x: 0, y: 0 }, 'group');
  handler.data.label = 'Home DNS';
  handler.data.settings.tag = 'dns';
  group.data.label = 'Fastest server';
  group.data.settings.tag = 'auto';
  graph.nodes.push(handler, group);
  const names = displayNames(graph, {
    outbounds: [{ tag: 'dns', protocol: 'dns' }],
    routing: { balancers: [{ tag: 'auto' }] },
  });
  expect(names.outbound).toEqual({ dns: 'Home DNS', auto: 'Fastest server' });
});

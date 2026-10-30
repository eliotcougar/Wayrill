import { expect, it } from 'vitest';
import { createChainedExample } from './chainedExample';
import { compileRuntimeGraph } from './runtime';

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

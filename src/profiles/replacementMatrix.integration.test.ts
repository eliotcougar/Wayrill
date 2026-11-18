import { expect, it } from 'vitest';
import { analyzeGraph } from '../graph/analysis';
import { checkCoreConfig } from '../test/coreIntegration';
import { graph, replacementCases } from './replacementMatrix.fixture';

for (const { label, candidate } of replacementCases) {
  it(label + ' passes the pinned Xray configuration parser', () => {
    const next = candidate();
    expect(next.edges.filter((edge) => edge.target === 'proxy')).toMatchObject(
      graph.edges.filter((edge) => edge.target === 'proxy'),
    );
    expect(next.nodes.find((node) => node.id === 'proxy')?.data.settings.tag).toBe('proxy');
    const { issues, compilation } = analyzeGraph(next);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const result = checkCoreConfig('replacement-' + label, compilation!.config);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}

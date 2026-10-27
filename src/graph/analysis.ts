import { diagnoseRuntimeGraph } from './diagnostics';
import { diagnoseGraph } from './model';
import { compileRuntimeGraph, type RuntimeCompilation } from './runtime';
import type { Diagnostic, GraphState } from './types';
export interface GraphAnalysis {
  issues: Diagnostic[];
  compilation: RuntimeCompilation | null;
  configBytes: number;
}
export const emptyAnalysis = (): GraphAnalysis => ({
  issues: [],
  compilation: null,
  configBytes: 0,
});
export type AnalysisScope = 'runtime' | 'nodes';
export function analyzeGraph(graph: GraphState, scope: AnalysisScope = 'runtime'): GraphAnalysis {
  let issues: Diagnostic[];
  try {
    issues = scope === 'nodes' ? diagnoseGraph(graph) : diagnoseRuntimeGraph(graph);
  } catch (error) {
    return {
      ...emptyAnalysis(),
      issues: [
        {
          severity: 'error',
          message: error instanceof Error ? error.message : 'Unable to check this graph.',
        },
      ],
    };
  }
  if (scope === 'nodes') return { ...emptyAnalysis(), issues };
  try {
    const compilation = compileRuntimeGraph(graph);
    return {
      issues,
      compilation,
      configBytes: new TextEncoder().encode(JSON.stringify(compilation.config)).length,
    };
  } catch {
    return { issues, compilation: null, configBytes: 0 };
  }
}
export function largeGraph(graph: GraphState) {
  if ((graph.xray?.outboundPool?.length ?? 0) > 500) return true;
  // Even a small shared filter DAG can expand to thousands of routing paths.
  const filters = new Set(
    graph.nodes.filter((node) => node.data.kind === 'routing-filter').map((node) => node.id),
  );
  if (graph.edges.some((edge) => filters.has(edge.source) && filters.has(edge.target))) return true;
  // Rule tables and raw protocol/DNS JSON can be as large as a policy pool.
  // Count all settings, rather than relying on a list of particular field names.
  let characters = 0;
  for (const node of graph.nodes)
    for (const value of Object.values(node.data.settings)) {
      if (typeof value === 'string') characters += value.length;
      if (characters > 64 * 1024) return true;
    }
  return false;
}

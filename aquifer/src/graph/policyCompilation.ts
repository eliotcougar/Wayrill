import { compilePolicies as compileFlatPolicies, type PolicyCompilation } from './policies';
import { expandCompositeOutbounds } from './composites';
import { xrayOutboundConfig } from './xrayCompiler';
import type { GraphState } from './types';
export function compilePolicies(
  graph: GraphState,
  available: Record<string, unknown>[],
): PolicyCompilation {
  const expanded = expandCompositeOutbounds(graph);
  if (expanded.changed) {
    const configs = expanded.graph.nodes
      .filter((n) => n.data.kind === 'xray-outbound')
      .map((n) => xrayOutboundConfig(n.data));
    const replaced = new Set(configs.map((c) => c.tag));
    const complete = [...available.filter((c) => !replaced.has(c.tag)), ...configs];
    const compiled = compilePolicies(expanded.graph, complete);
    const original = new Set(available.map((c) => c.tag));
    return {
      ...compiled,
      rules: [...expanded.rules, ...(compiled.rules ?? [])],
      outbounds: [...configs.filter((c) => !original.has(c.tag)), ...compiled.outbounds],
    };
  }
  return compileFlatPolicies(graph, available);
}

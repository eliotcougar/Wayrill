import { compileDnsGraph as compileFlatDns, type DnsFragment } from './dns';
import { expandCompositeOutbounds } from './composites';
import { nativeConfig } from './xrayNodes';
import { resourceCompilationGraph } from './resources';
import { resolveGraph } from './defaults';
import type { GraphState } from './types';
export function compileDnsGraph(
  source: GraphState,
  options: { includePolicies?: boolean; resourcesResolved?: boolean } = {},
): DnsFragment {
  const expanded = expandCompositeOutbounds(
    resolveGraph(options.resourcesResolved ? source : resourceCompilationGraph(source)),
  );
  const fragment = compileFlatDns(expanded.graph, { ...options, resourcesResolved: true });
  if (!expanded.changed) return fragment;
  const outputs = new Map(fragment.outbounds.map((o) => [o.tag, o]));
  for (const node of expanded.graph.nodes.filter((n) => n.data.kind === 'xray-outbound')) {
    const config = nativeConfig(node.data);
    outputs.set(config.tag, config);
  }
  return {
    ...fragment,
    outbounds: [...outputs.values()],
    routing: { ...fragment.routing, rules: [...expanded.rules, ...fragment.routing.rules] },
  };
}

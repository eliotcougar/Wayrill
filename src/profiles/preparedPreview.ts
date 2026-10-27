import { preparedEntry, expandCompositeOutbounds } from '../graph/composites';
import { makeNode } from '../graph/catalog';
import { compilePolicies } from '../graph/policyCompilation';
import { xrayOutboundConfig } from '../graph/xrayCompiler';
import type { GraphState, RuleNode } from '../graph/types';
import { LIMITS } from '../limits';

/** Validate only this reusable definition; unrelated unfinished canvas nodes are irrelevant. */
export function preparedPreview(graph: GraphState, node: RuleNode) {
  const entry = preparedEntry(graph, node.id);
  const root = makeNode(entry.profile!.kind, { x: 0, y: 0 }, node.id);
  root.data = {
    ...root.data,
    label: entry.name,
    settings: { ...root.data.settings, ...entry.profile!.settings },
  };
  const observation = graph.edges.find(
    (e) => e.source === node.id && e.sourceHandle === 'observation',
  );
  const observer =
    observation &&
    graph.nodes.find((n) => n.id === observation.target && n.data.kind === 'observatory');
  const isolated: GraphState = {
    ...graph,
    nodes: [root, ...(observer ? [observer] : [])],
    edges: graph.edges.filter((e) => e.source === node.id && e.sourceHandle === 'observation'),
  };
  delete isolated.xray;
  const expansion = expandCompositeOutbounds(isolated);
  const outbounds = expansion.graph.nodes
    .filter((n) => n.data.kind !== 'policy-group' && n.data.kind !== 'observatory')
    .map((n) => xrayOutboundConfig(n.data));
  const policy = compilePolicies(expansion.graph, outbounds);
  const config = {
    outbounds: [...outbounds, ...policy.outbounds],
    routing: { rules: expansion.rules, balancers: policy.balancers },
    ...policy.observation,
  };
  if (config.outbounds.length > LIMITS.maxOutbounds)
    throw new Error('Prepared outbound exceeds the executable outbound budget.');
  if (new TextEncoder().encode(JSON.stringify(config)).length > LIMITS.configBytes)
    throw new Error('Prepared outbound exceeds the 16 MiB configuration budget.');
  return { config, warnings: policy.warnings };
}

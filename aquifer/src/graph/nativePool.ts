import { jsonText } from './xrayJson';
import { boundedText } from '../text';
import type { GraphState, RuleNode, XrayGraphMetadata } from './types';

// Imported internal candidates remain raw config, with virtual nodes for existing
// policy editors/compiler code. They never become React Flow canvas elements.
const cache = new WeakMap<XrayGraphMetadata, RuleNode[]>();
const indexes = new WeakMap<
  GraphState,
  { nodes: RuleNode[]; meta: XrayGraphMetadata | undefined; value: Map<string, RuleNode> }
>();
export function nativePoolNodes(graph: GraphState): RuleNode[] {
  const meta = graph.xray;
  if (!meta?.outboundPool?.length) return [];
  const cached = cache.get(meta);
  if (cached) return cached;
  const nodes = meta.outboundPool.map(({ id, config }) => {
    const { tag, ...options } = config;
    const projection = { ...options, ...(tag ? { tag } : {}) };
    return {
      id,
      type: 'rule' as const,
      position: { x: 0, y: 0 },
      data: {
        kind: 'xray-outbound' as const,
        label: boundedText(jsonText(tag ?? id), 128),
        description: 'Internal outbound from the imported configuration',
        overrides: [],
        settings: { tag: jsonText(tag ?? ''), json: JSON.stringify(options) },
        native: { version: 1 as const, original: config, projection },
      },
    };
  });
  cache.set(meta, nodes);
  return nodes;
}
export function allOutboundNodes(graph: GraphState): RuleNode[] {
  const pool = nativePoolNodes(graph),
    canvasIds = new Set(graph.nodes.map((n) => n.id));
  if (pool.some((n) => canvasIds.has(n.id)))
    throw new Error('A canvas node ID conflicts with an imported internal outbound.');
  return [...graph.nodes, ...pool];
}
export function outboundNodeIndex(graph: GraphState): ReadonlyMap<string, RuleNode> {
  const previous = indexes.get(graph);
  if (previous?.nodes === graph.nodes && previous.meta === graph.xray) return previous.value;
  const value = new Map(allOutboundNodes(graph).map((n) => [n.id, n]));
  indexes.set(graph, { nodes: graph.nodes, meta: graph.xray, value });
  return value;
}

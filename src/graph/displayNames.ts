import { jsonArray, jsonRecord } from './xrayJson';
import type { GraphState } from './types';
import { getDefinition } from './catalog';
import { getRoutingTrace, type RoutingHop } from './routingTrace';
export type DisplayNames = {
  inbound: Record<string, string>;
  outbound: Record<string, string>;
  routing?: Record<string, RoutingHop[]>;
  routingDefault?: RoutingHop[];
};
/** Names belong to the applied revision, never to subsequently edited graph labels. */
export function displayNames(
  graph: GraphState,
  config: Record<string, unknown>,
  aliases: Record<string, string> = {},
): DisplayNames {
  const names: DisplayNames = {
    inbound: Object.create(null) as Record<string, string>,
    outbound: Object.create(null) as Record<string, string>,
  };
  const nodeNames = { inbound: new Map<string, string>(), outbound: new Map<string, string>() };
  for (const node of graph.nodes) {
    const category = getDefinition(node.data.kind).category;
    if (
      (category === 'inbound' || category === 'outbound') &&
      typeof node.data.settings.tag === 'string'
    )
      nodeNames[category === 'inbound' ? 'inbound' : 'outbound'].set(
        node.data.settings.tag,
        node.data.label,
      );
  }
  for (const [key, list] of [
    ['inbound', config.inbounds],
    ['outbound', config.outbounds],
  ] as const) {
    if (!jsonArray(list)) continue;
    for (const item of list) {
      if (!jsonRecord(item) || typeof item.tag !== 'string') continue;
      const name =
        key === 'outbound' && Object.hasOwn(aliases, item.tag)
          ? aliases[item.tag]
          : nodeNames[key].get(item.tag);
      if (name) names[key][item.tag] = Array.from(name).slice(0, 160).join('');
    }
  }
  const routing = config.routing;
  if (jsonRecord(routing) && jsonArray(routing.rules)) {
    const traces: Record<string, RoutingHop[]> = {};
    routing.rules.forEach((rule, index) => {
      if (jsonRecord(rule)) {
        const trail = getRoutingTrace(rule);
        if (trail?.length) traces[String(index)] = trail;
      }
    });
    if (Object.keys(traces).length) names.routing = traces;
  }
  return names;
}

export function endpointDisplayName(
  names: DisplayNames | undefined,
  scope: 'inbound' | 'outbound',
  tag: string,
): string {
  const map = names?.[scope];
  return map && Object.hasOwn(map, tag) && typeof map[tag] === 'string' ? map[tag] : tag;
}

import { sourceConnectionKind } from './connectionTypes';
import { isDisabledInbound, isGraphInbound } from './inboundState';
import { getOutputPorts } from './catalog';
import type { TrafficEndpoint } from '../traffic';
import { jsonArray, jsonRecord } from './xrayJson';
import type { GraphState } from './types';
import type { RuntimeCompilation } from './runtime';

export const GRAPH_ACTIVITY_KEY = 'wayrill.appearance.trafficGlow';

export type ActivitySnapshot = {
  instanceId: string;
  generation: number | null;
  revision: number | null;
  state: 'collecting' | 'stopped';
  /** Routing matches in the last two seconds, grouped by compiled rule index. */
  rules: { index: number; matches: number }[];
};
export type ActivityPlan = {
  rules: Map<number, { edges: string[]; ports: string[] }>;
  inlets: Map<string, string>;
};
export type GraphActivity = {
  edges: ReadonlyMap<string, number>;
  ports: ReadonlyMap<string, number>;
};
export const noGraphActivity: GraphActivity = { edges: new Map(), ports: new Map() };
export const activityPortKey = (node: string, type: string, port: string) =>
  JSON.stringify([node, type, port]);

type ActivityWire = { id: string; source: string; target: string };

/** Only explicit compiler provenance may light a wire. Never walk backwards from
 * a busy outbound: separate branches can share it without sharing a decision.
 */
export function graphActivityPlan(
  graph: GraphState,
  compilation: RuntimeCompilation,
): ActivityPlan {
  const nodes = new Map(
    graph.nodes.filter((n) => !isDisabledInbound(n.data)).map((n) => [n.id, n]),
  );
  const outputs = new Map<string, Map<string, ActivityWire[]>>();
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    if (!source || !nodes.has(edge.target)) continue;
    const kind = sourceConnectionKind(source.data, edge.sourceHandle ?? '');
    if (kind !== 'traffic' && kind !== 'dns-traffic') continue;
    let ports = outputs.get(edge.source);
    if (!ports) {
      ports = new Map();
      outputs.set(edge.source, ports);
    }
    const handle = edge.sourceHandle ?? '';
    let wires = ports.get(handle);
    if (!wires) {
      wires = [];
      ports.set(handle, wires);
    }
    wires.push({
      id: edge.id,
      source: activityPortKey(edge.source, 'source', handle),
      target: activityPortKey(edge.target, 'target', edge.targetHandle ?? 'in'),
    });
  }
  const routing = jsonRecord(compilation.config.routing) ? compilation.config.routing : {};
  const rules = jsonArray(routing.rules) ? routing.rules : [];
  const plan: ActivityPlan = { rules: new Map(), inlets: new Map() };
  for (const node of nodes.values()) {
    if (!isGraphInbound(node.data.kind)) continue;
    const ports = getOutputPorts(node.data.kind, node.data);
    const port = ports.includes('traffic') ? 'traffic' : 'data';
    if (ports.includes(port))
      plan.inlets.set(String(node.data.settings.tag), activityPortKey(node.id, 'source', port));
  }
  // The service can append an observed implicit fallback at rules.length.
  for (let index = 0; index <= rules.length; index++) {
    const edges = new Set<string>();
    const ports = new Set<string>();
    const add = (node: string, port: string) => {
      for (const wire of outputs.get(node)?.get(port) ?? []) {
        edges.add(wire.id);
        ports.add(wire.source);
        ports.add(wire.target);
      }
    };
    const input = compilation.activityInputs?.[index];
    if (input) add(input.nodeId, input.port);
    const trail =
      index === rules.length
        ? compilation.displayNames?.routingDefault
        : compilation.displayNames?.routing?.[index];
    for (const hop of trail ?? []) add(hop.filterId, hop.outputId);
    if (edges.size) plan.rules.set(index, { edges: [...edges], ports: [...ports] });
  }
  return plan;
}

/** One match is visible; bursts brighten logarithmically rather than flashing. */
export const activityIntensity = (matches: number) =>
  Number.isFinite(matches) && matches > 0
    ? Math.min(1, Math.log1p(matches * 4) / Math.log1p(200))
    : 0;

export function graphActivity(
  plan: ActivityPlan,
  rules: ActivitySnapshot['rules'],
  endpoints: readonly TrafficEndpoint[] = [],
): GraphActivity {
  const edges = new Map<string, number>(),
    ports = new Map<string, number>();
  const increment = (map: Map<string, number>, key: string, count: number) =>
    map.set(key, (map.get(key) ?? 0) + count);
  for (const { index, matches } of rules) {
    if (!Number.isFinite(matches) || matches <= 0) continue;
    const route = plan.rules.get(index);
    if (!route) continue;
    for (const id of route.edges) increment(edges, id, matches);
    for (const key of route.ports) increment(ports, key, matches);
  }
  const levels = new Map([...ports].map(([key, count]) => [key, activityIntensity(count)]));
  // Only the main source port uses throughput; never smear its bytes across branches.
  for (const key of plan.inlets.values()) levels.delete(key);
  for (const endpoint of endpoints) {
    const key = endpoint.scope === 'inbound' ? plan.inlets.get(endpoint.tag) : undefined;
    if (!key) continue;
    const rate = [endpoint.uploadPerSecond, endpoint.downloadPerSecond].reduce<number>(
      (sum, value) => sum + (value != null && Number.isFinite(value) && value > 0 ? value : 0),
      0,
    );
    if (rate > 0) levels.set(key, Math.min(1, Math.log1p(rate / 1024) / Math.log1p(100 * 1024)));
  }
  if (!edges.size && !levels.size) return noGraphActivity;
  return {
    edges: new Map([...edges].map(([key, count]) => [key, activityIntensity(count)])),
    ports: levels,
  };
}

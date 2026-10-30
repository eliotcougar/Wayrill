import { inboundPreFilters } from './inbounds';
import type { RuleNode } from './types';
import { LIMITS } from '../limits';
import { copyRoutingTrace } from './routingTrace';
import { jsonArray, parseJson } from './xrayJson';
import { isDisabledInbound } from './inboundState';
import type { GraphState } from './types';
import { routingPaths, RoutingPathError } from './routingPaths';
import { intersectNativeProcesses } from './nativePredicates';
import { readRuleTable } from './rules';
import { NAT_ROUTING_TAG } from './tun';

export type { ApplicationSelector as CaptureSelector } from './applications';
import {
  parseApplicationSelectors,
  nativeProcessSelectors,
  selectorKey,
  processProfiles,
  processMaskPattern,
  type ApplicationSelector as CaptureSelector,
} from './applications';
export interface CaptureOptions {
  interfaces: {
    monitorNewInterfaces: boolean;
    interfaces: { id: string; name: string; monitored: boolean }[];
  };
  bypassLocalTraffic: boolean;
}
export interface CapturePlan extends CaptureOptions {
  version: 2;
  sharingDisabled?: boolean;
  tunSharing?: {
    tag: string;
    expectedVersion: string;
    publicId: string;
    privateId: string;
    upstreamTags: string[];
    ipv6: boolean;
  };
  inputs: {
    source?: 'tun';
    tag: string;
    selectors: CaptureSelector[];
    ports: string;
    networks: string[];
    predicates: CaptureSelector[][];
    masks: string[];
    natTag?: string;
    /** Reserved authenticated identity; never emitted for an ordinary owner. */
    ambiguousMask?: string;
  }[];
}
export const defaultCaptureOptions = (): CaptureOptions => ({
  interfaces: { monitorNewInterfaces: true, interfaces: [] },
  bypassLocalTraffic: true,
});
export function parseCaptureOptions(value: unknown): CaptureOptions {
  if (!value || typeof value !== 'object') throw new Error('Invalid capture options.');
  const v = value as CaptureOptions;
  if (
    typeof v.bypassLocalTraffic !== 'boolean' ||
    !v.interfaces ||
    typeof v.interfaces.monitorNewInterfaces !== 'boolean' ||
    !jsonArray(v.interfaces.interfaces) ||
    v.interfaces.interfaces.length > 1024
  )
    throw new Error('Invalid capture interface options.');
  const ids = new Set<string>();
  for (const item of v.interfaces.interfaces) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id.length > 128 ||
      typeof item.name !== 'string' ||
      item.name.length > 512 ||
      typeof item.monitored !== 'boolean' ||
      ids.has(item.id.toLowerCase())
    )
      throw new Error('Invalid or duplicate capture interface choice.');
    ids.add(item.id.toLowerCase());
  }
  return structuredClone(v);
}
export function orderedCaptureInbounds(graph: GraphState) {
  return graph.nodes
    .filter((n) => n.data.kind === 'windivert-inbound' && !isDisabledInbound(n.data))
    .sort(
      (a, b) => Number(a.data.settings.capturePriority) - Number(b.data.settings.capturePriority),
    );
}

/** Only enabled traffic paths grant a shared filter access to capture metadata. */
export function captureReachableFilters(graph: GraphState): Set<string> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const outgoing = edges.get(edge.source) ?? [];
    outgoing.push(edge);
    edges.set(edge.source, outgoing);
  }
  const pending = graph.nodes.filter(
    (node) =>
      ['tun-inbound', 'windivert-inbound'].includes(node.data.kind) &&
      !isDisabledInbound(node.data),
  );
  const filters = new Set<string>();
  while (pending.length) {
    const node = pending.pop()!;
    const table =
      node.data.kind === 'routing-filter' ? readRuleTable(node.data.settings) : undefined;
    const outputs =
      table &&
      new Set([
        table.defaultOutput,
        ...(table.tunAmbiguity?.action === 'allow' && table.tunAmbiguity.output
          ? [table.tunAmbiguity.output]
          : []),
        ...table.rules.filter((rule) => rule.enabled).map((rule) => rule.output),
      ]);
    for (const edge of edges.get(node.id) ?? []) {
      if (outputs && !outputs.has(edge.sourceHandle!)) continue;
      const target = byId.get(edge.target);
      if (target?.data.kind !== 'routing-filter' || filters.has(target.id)) continue;
      filters.add(target.id);
      pending.push(target);
    }
  }
  return filters;
}
export function compileCapturePlan(graph: GraphState): CapturePlan | undefined {
  const nodes = orderedCaptureInbounds(graph);
  const tuns = graph.nodes.filter(
    (n) => n.data.kind === 'tun-inbound' && !isDisabledInbound(n.data),
  );
  const shared = graph.nodes.find((n) => n.data.kind === 'ics-tun' && !isDisabledInbound(n.data));
  if (!nodes.length && !tuns.length && !shared) return undefined;
  if (nodes.length > 16)
    throw new RoutingPathError(
      nodes[16].id,
      'Use at most 16 WinDivert capture inputs per running graph.',
    );
  return {
    version: 2,
    ...(shared
      ? {
          tunSharing: {
            tag: String(shared.data.settings.tag),
            expectedVersion: String(shared.data.settings.sharingVersion),
            publicId: String(shared.data.settings.publicId),
            privateId: String(shared.data.settings.privateId),
            ipv6: shared.data.settings.shareIpv6 === true,
            upstreamTags: graph.nodes
              .filter(
                (n) => n.data.kind === 'direct-outbound' && n.data.settings.icsUpstream === true,
              )
              .map((n) => String(n.data.settings.tag)),
          },
        }
      : {}),
    ...(graph.captureOptions ?? defaultCaptureOptions()),
    inputs: [...nodes, ...tuns].map((n) => ({
      ...(n.data.kind === 'tun-inbound' ? { source: 'tun' as const } : {}),
      ...(n.data.kind === 'tun-inbound' ? { natTag: NAT_ROUTING_TAG } : {}),
      tag: String(n.data.settings.tag),
      selectors: [],
      ports: '',
      networks: ['tcp', 'udp'],
      predicates: [],
      masks: ['0'],
    })),
  };
}

/** Keep Xray's first-match rules intact; carry every matching Windows predicate
 * in SOCKS user metadata instead of choosing a route prematurely in capture. */
export function compileCaptureRouting(
  graph: GraphState,
  config: Record<string, unknown>,
): CapturePlan | undefined {
  const plan = compileCapturePlan(graph);
  const routing = config.routing as { rules?: Record<string, unknown>[] } | undefined;
  const rules = routing?.rules ?? [];
  if (!plan) {
    if (rules.some((r) => r._wayrillApplications))
      throw new Error(
        'Windows apps, services and child-process conditions require a connected TUN or WinDivert source.',
      );
    return undefined;
  }
  const predicates: CaptureSelector[][] = [],
    keys = new Map<string, number>();
  const index = (rows: CaptureSelector[]) => {
    const key = selectorKey(rows);
    const old = keys.get(key);
    if (old !== undefined) return old;
    if (predicates.reduce((n, p) => n + p.length, 0) + rows.length > 4096)
      throw new Error(
        'Windows routing supports at most 4,096 selectors across distinct application conditions.',
      );
    keys.set(key, predicates.length);
    predicates.push(rows);
    return predicates.length - 1;
  };
  const captureTags = new Set(plan.inputs.map((i) => i.tag));
  const allTags = (config.inbounds as Record<string, unknown>[]).map((i) => String(i.tag));
  const icsTag = plan.tunSharing?.tag;
  const output: Record<string, unknown>[] = [];
  for (const rule of rules) {
    const groups =
      (rule._wayrillApplications as string[] | undefined)?.map((s) =>
        parseApplicationSelectors(parseJson(s)),
      ) ?? [];
    if (jsonArray(rule.process) && rule.process.length)
      groups.push(nativeProcessSelectors(rule.process.map(String)));
    const clean = copyRoutingTrace(rule, { ...rule });
    delete clean._wayrillApplications;
    if (!groups.length) {
      output.push(clean);
      continue;
    }
    const tags = jsonArray(rule.inboundTag) ? rule.inboundTag.map(String) : allTags;
    const captured = tags.filter((t) => captureTags.has(t)),
      ordinary = tags.filter((t) => !captureTags.has(t) && t !== icsTag);
    if (ordinary.length) {
      const nativeGroups = groups.map((rows) =>
        rows
          .filter((r) => r.enabled && r.kind === 'process' && !r.children)
          .map((r) => (r.mode === 'folder' ? r.value.replace(/[\\/]?$/, '/') : r.value)),
      );
      // Every entering group is required (AND). An unrepresentable service or
      // package group must not disappear and broaden the remaining predicates.
      if (nativeGroups.every((names) => names.length)) {
        const processes = nativeGroups.reduce(
          (previous, names) => intersectNativeProcesses(previous, names) ?? [],
        );
        if (processes.length)
          output.push(
            copyRoutingTrace(clean, { ...clean, inboundTag: ordinary, process: processes }),
          );
      }
    }
    if (captured.length) {
      if (rule.user)
        throw new Error(
          'A local capture application condition cannot also match an inbound account email.',
        );
      delete clean.process;
      output.push(
        copyRoutingTrace(clean, {
          ...clean,
          inboundTag: captured,
          _wayrillRequired: groups.map(index),
        }),
      );
    }
  }
  const masks = processProfiles(predicates);
  const allowAmbiguity = graph.nodes.some(
    (n) =>
      n.data.kind === 'routing-filter' &&
      readRuleTable(n.data.settings).tunAmbiguity?.action === 'allow',
  );
  const tunTags = new Set(plan.inputs.filter((i) => i.source === 'tun').map((i) => i.tag));
  const ambiguousMask = allowAmbiguity && tunTags.size ? unusedIdentityMask(masks) : undefined;
  const finalized = output.flatMap((rule) => {
    const required = rule._wayrillRequired as number[] | undefined;
    if (!required) return [rule];
    delete rule._wayrillRequired;
    const tags = rule.inboundTag as string[];
    if (!ambiguousMask) {
      rule.user = [processMaskPattern(required, predicates.length)];
      return [rule];
    }
    return [tags.filter((t) => tunTags.has(t)), tags.filter((t) => !tunTags.has(t))]
      .filter((scope) => scope.length)
      .map((scope) =>
        copyRoutingTrace(rule, {
          ...rule,
          inboundTag: scope,
          user: [
            processMaskPattern(
              required,
              predicates.length,
              tunTags.has(scope[0]) ? ambiguousMask.length : undefined,
            ),
          ],
        }),
      );
  });
  const destinationRouting =
    routing ?? (ambiguousMask ? { rules: [] as Record<string, unknown>[] } : undefined);
  if (destinationRouting) {
    if (!routing) config.routing = destinationRouting;
    destinationRouting.rules = ambiguousMask
      ? [...ambiguousTunRules(graph, config, plan, ambiguousMask), ...finalized]
      : finalized;
    if (
      destinationRouting.rules.length > LIMITS.maxRoutingRules ||
      ((config.outbounds as unknown[] | undefined)?.length ?? 0) > LIMITS.maxOutbounds
    )
      throw new Error('Ambiguous TUN routing exceeds the runtime rule or outbound limit.');
  }
  for (const input of plan.inputs) {
    input.predicates = predicates;
    input.masks = masks;
    if (input.source === 'tun' && ambiguousMask) input.ambiguousMask = ambiguousMask;
  }
  if (new TextEncoder().encode(JSON.stringify(plan)).length > 2 * 1024 * 1024)
    throw new Error('Windows capture plan exceeds 2 MiB.');
  return plan.inputs.length || plan.tunSharing ? plan : undefined;
}

/** Choose an identity outside the complete set of valid process profiles. At
 * most 4096 profiles exist; even a full 12-bit set needs only one extra digit. */
export function unusedIdentityMask(masks: string[]): string {
  const used = new Set(masks.map((mask) => BigInt(`0x${mask}`)));
  let value = 1n;
  while (used.has(value)) value++;
  return value.toString(16).padStart(masks[0].length, '0');
}
function ambiguousTunRules(
  graph: GraphState,
  config: Record<string, unknown>,
  plan: CapturePlan,
  mask: string,
) {
  const outbounds = config.outbounds as Record<string, unknown>[];
  const blockTag = 'wr-a';
  if (outbounds.some((o) => o.tag === blockTag)) throw new Error('The tag wr-a is reserved.');
  outbounds.push({
    tag: blockTag,
    protocol: 'blackhole',
    settings: { response: { type: 'none' } },
  });
  const paths = routingPaths(graph, (config.routing as { rules?: unknown[] })?.rules?.length ?? 0);
  const rules: Record<string, unknown>[] = [];
  for (const input of plan.inputs.filter((i) => i.source === 'tun')) {
    const source = graph.nodes.find(
      (n) => n.data.kind === 'tun-inbound' && n.data.settings.tag === input.tag,
    )!;
    const target = paths.connected(source, 'traffic');
    const scope = { inboundTag: [input.tag], user: [`regexp:^wr-${mask}-[0-9a-f]{48}$`] };
    const terminal = (n: RuleNode) =>
      n.data.kind === 'policy-group'
        ? { balancerTag: String(n.data.settings.tag) }
        : { outboundTag: String(n.data.settings.tag) };
    const route = (
      destination: RuleNode,
      match: Record<string, unknown>,
      allowUnfiltered = false,
    ) => {
      if (destination.data.kind === 'routing-filter')
        rules.push(...paths.expand(destination, match, { tunAmbiguity: { blockTag }, terminal }));
      else
        rules.push({
          type: 'field',
          ...match,
          ...(allowUnfiltered ? terminal(destination) : { outboundTag: blockTag }),
        });
    };
    const dataAllows =
      target.data.kind === 'routing-filter' &&
      readRuleTable(target.data.settings).tunAmbiguity?.action === 'allow';
    // Preserve source preclassification. A DNS filter has its own explicit
    // policy; an unfiltered resolver inherits the source Data filter's Allow.
    for (const branch of inboundPreFilters(source.data).filter((b) => b.branch !== 'data')) {
      if (graph.edges.some((e) => e.source === source.id && e.sourceHandle === branch.branch))
        route(
          paths.connected(source, branch.branch),
          { ...branch.match, user: scope.user },
          dataAllows,
        );
    }
    route(target, scope);
  }
  return rules;
}

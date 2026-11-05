import { copyRoutingTrace } from './routingTrace';
import { makeNode, uniqueInboundTag, uniqueOutboundTag } from './catalog';
import { resolveNodeData } from './defaults';
import { protocolConfig, protocolJson } from './protocols';
import { tunCaptureScope } from './tun';
import { clearNodePosition } from './placement';
import { isDisabledInbound, isGraphInbound } from './inboundState';
import { captureRuleVariants, readRuleTable, tableSettings, type TableRule } from './rules';
import { RoutingPathError } from './routingPaths';
import type { Diagnostic, GraphState, RuleNode } from './types';

export interface SharingInspection {
  version: string;
  managed: boolean;
  hasSavedPair?: boolean;
  restoreNativeOnBoot?: boolean;
  windowsSharingActive?: boolean;
  recoveryPending: boolean;
  restartRequired?: boolean;
  ipv6Forwarding?: {
    upstream: string;
    original: boolean;
    phase: string;
  } | null;
  ipv6Clients?: { prefix: string; phase: string; private: string } | null;
  lastError: { code?: string; message: string } | null;
  connections: {
    id: string;
    name: string;
    role: number | null;
    portMappings?: {
      name: string;
      protocol: number;
      externalPort: number;
      internalPort: number;
      target: string;
      targetName: string;
    }[];
  }[];
  pair: {
    public: { id: string; name: string };
    private: { id: string; name: string };
  } | null;
  supported: boolean;
  source?: 'native' | 'managed' | 'remembered';
  problem?: string;
}
export const hasIcsCapture = (graph: GraphState) =>
  graph.nodes.some((node) => node.data.kind === 'ics-tun');

export function canUseSharing(value: SharingInspection | undefined): value is SharingInspection & {
  pair: NonNullable<SharingInspection['pair']>;
} {
  return !!(
    value?.supported &&
    value.pair &&
    (!value.recoveryPending || value.source === 'remembered')
  );
}
export const unsupportedSharedFields = new Set([
  'process',
  '_wayrillApplications',
  'sourceIP',
  'sourcePort',
  'user',
  'localIP',
  'localPort',
  'localOS',
  'vlessRoute',
]);
const populated = (value: unknown) =>
  value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
const directBehavior = (node: RuleNode, graph: GraphState) => {
  const settings = {
    ...resolveNodeData(node.data, graph.defaults).settings,
    tag: '',
    icsUpstream: true,
  };
  return JSON.stringify(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
};

/** Evaluate eligibility of complete variants; dropping one AND term would broaden a rule. */
export function sharedRuleVariants(
  row: TableRule,
  host: boolean,
  warnings: string[],
  node: RuleNode,
) {
  const variants = captureRuleVariants(row, 'capture');
  const eligible = variants.filter(
    (v) =>
      !Object.entries(v).some(
        ([key, value]) => unsupportedSharedFields.has(key) && populated(value),
      ),
  );
  if (eligible.length !== variants.length) {
    const message = `${node.data.label}: ${row.name} — process and source identity conditions are unsupported for shared traffic.`;
    if (!eligible.length && !host) {
      const error = new RoutingPathError(
        node.id,
        `${message} Disable this rule or use destination conditions.`,
      );
      Object.assign(error, { rowId: row.id });
      throw error;
    }
    warnings.push(`${message} Only eligible destination alternatives apply to ICS.`);
  }
  return eligible;
}

export function sharedFilterSources(graph: GraphState, filterId: string) {
  const pending = [filterId],
    seen = new Set<string>();
  let shared = false,
    host = false;
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.edges.filter((e) => e.target === id)) {
      const node = graph.nodes.find((n) => n.id === edge.source);
      if (!node || isDisabledInbound(node.data)) continue;
      if (node.data.kind === 'ics-tun') shared = true;
      else if (isGraphInbound(node.data.kind)) host = true;
      else if (node.data.kind === 'routing-filter') {
        const table = readRuleTable(node.data.settings);
        if (
          table.defaultOutput === edge.sourceHandle ||
          table.rules.some((r) => r.enabled && r.output === edge.sourceHandle)
        )
          pending.push(node.id);
      }
    }
  }
  return { shared, host };
}

export function sharedRuleProblems(graph: GraphState, node: RuleNode): Diagnostic[] {
  const scope = sharedFilterSources(graph, node.id);
  if (!scope.shared) return [];
  const problems: Diagnostic[] = [];
  for (const row of readRuleTable(node.data.settings).rules.filter((r) => r.enabled)) {
    const warnings: string[] = [];
    try {
      sharedRuleVariants(row, scope.host, warnings, node);
    } catch (error) {
      problems.push({
        severity: 'error',
        nodeId: node.id,
        rowId: row.id,
        fieldKey: 'rules',
        message: (error as Error).message,
      });
    }
    problems.push(
      ...warnings.map((message) => ({
        severity: 'warning' as const,
        nodeId: node.id,
        rowId: row.id,
        fieldKey: 'rules',
        message,
      })),
    );
  }
  return problems;
}
export function sharedIpv6Ready(graph: GraphState): boolean {
  const node = graph.nodes.find((n) => n.data.kind === 'tun-inbound' && !isDisabledInbound(n.data));
  if (!node) return false;
  try {
    const settings = protocolConfig(resolveNodeData(node.data, graph.defaults)).settings as Record<
      string,
      unknown
    >;
    const halves = new Set<number>();
    let all = false;
    for (const route of Array.isArray(settings.autoSystemRoutingTable)
      ? settings.autoSystemRoutingTable
      : []) {
      if (typeof route !== 'string' || !route.includes(':')) continue;
      const [ip, bits] = route.split('/');
      const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
      if (bits === '0') all = true;
      if (bits === '1')
        halves.add(
          normalized.startsWith(':')
            ? 0
            : Number.parseInt(normalized.split(':')[0], 16) >= 0x8000
              ? 1
              : 0,
        );
    }
    return (
      (all || halves.size === 2) &&
      (!settings.mtu ||
        (Number.isInteger(settings.mtu) &&
          Number(settings.mtu) >= 1280 &&
          Number(settings.mtu) <= 65535)) &&
      Array.isArray(settings.gateway) &&
      settings.gateway.some(
        (v) => typeof v === 'string' && v.includes(':') && !/^(::(?:1\/|\/)|fe[89ab]|ff)/i.test(v),
      )
    );
  } catch {
    return false;
  }
}
/** An explicit draft action. Preserve existing wiring/uplink and leave Windows unchanged. */
export function configureSharedIpv6Host(graph: GraphState): GraphState {
  const next = structuredClone(graph);
  let host = next.nodes.find((n) => n.data.kind === 'tun-inbound');
  if (!host) {
    const shared = next.nodes.find((n) => n.data.kind === 'ics-tun')!;
    host = makeNode(
      'tun-inbound',
      clearNodePosition(next.nodes, {
        x: shared.position.x,
        y: shared.position.y + 280,
      }),
    );
    host.data.settings.tag = uniqueInboundTag('tun-traffic', next.nodes);
    next.nodes.push(host);
    let direct = next.nodes.find(
      (n) => n.data.kind === 'direct-outbound' && n.data.settings.icsUpstream === true,
    );
    if (!direct) {
      direct = makeNode(
        'direct-outbound',
        clearNodePosition(next.nodes, {
          x: host.position.x + 650,
          y: host.position.y,
        }),
      );
      direct.data.settings.tag = uniqueOutboundTag('ics-upstream', next.nodes);
      direct.data.settings.icsUpstream = true;
      direct.data.label = 'Direct — ICS upstream';
      next.nodes.push(direct);
    }
    next.edges.push({
      id: crypto.randomUUID(),
      source: host.id,
      sourceHandle: 'traffic',
      target: direct.id,
      targetHandle: 'in',
    });
    const dns = next.nodes.find((n) => n.data.kind === 'dns-handler');
    if (dns)
      next.edges.push({
        id: crypto.randomUUID(),
        source: host.id,
        sourceHandle: 'dns',
        target: dns.id,
        targetHandle: 'in',
      });
  }
  const native = protocolJson(host.data);
  const settings = tunCaptureScope((native.settings ?? {}) as Record<string, unknown>, true);
  if (Number(settings.mtu) > 0 && Number(settings.mtu) < 1280) settings.mtu = 1280;
  native.settings = settings;
  host.data.settings.json = JSON.stringify(native, null, 2);
  host.data.enabled = true;
  if (next.nodes.length > 500) throw new Error('The graph supports at most 500 nodes.');
  return next;
}
export function icsNodeProblems(graph: GraphState): Diagnostic[] {
  const nodes = graph.nodes.filter((n) => n.data.kind === 'ics-tun');
  const problems: Diagnostic[] = [];
  if (nodes.length > 1)
    problems.push({
      severity: 'error',
      nodeId: nodes[1].id,
      message: 'Keep only one ICS TUN node, including disabled nodes.',
    });
  for (const n of nodes.filter((n) => !isDisabledInbound(n.data))) {
    if (
      ![n.data.settings.publicId, n.data.settings.privateId].every(
        (v) => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),
      ) ||
      n.data.settings.publicId === n.data.settings.privateId ||
      !/^[a-f0-9]{64}$/.test(String(n.data.settings.sharingVersion))
    )
      problems.push({
        severity: 'error',
        nodeId: n.id,
        message: 'Inspect and confirm Windows sharing in the ICS TUN editor.',
        fieldKey: 'sharingVersion',
      });
    if (n.data.settings.shareIpv6 === true && !sharedIpv6Ready(graph))
      problems.push({
        severity: 'error',
        nodeId: n.id,
        fieldKey: 'shareIpv6',
        message:
          'IPv6 sharing requires an enabled dual-stack host TUN. Use Set up host IPv6 in the ICS TUN editor.',
      });
    if (!graph.edges.some((e) => e.source === n.id && e.sourceHandle === 'traffic'))
      problems.push({
        severity: 'error',
        nodeId: n.id,
        portId: 'traffic',
        message: `${n.data.label}: connect Data to an outbound or traffic filter.`,
      });
  }
  if (nodes.some((n) => !isDisabledInbound(n.data))) {
    for (const node of graph.nodes.filter((n) => n.data.kind === 'routing-filter')) {
      try {
        problems.push(...sharedRuleProblems(graph, node));
      } catch {
        /* Table validation reports malformed drafts. */
      }
    }
  }
  return problems;
}

/** Also guard preserved native rules; unsupported predicates never gain an ICS scope. */
export function sharedConfigRules(graph: GraphState, config: Record<string, unknown>) {
  const node = graph.nodes.find((n) => n.data.kind === 'ics-tun' && !isDisabledInbound(n.data));
  if (!node) return;
  const tag = String(node.data.settings.tag);
  const allTags = (config.inbounds as Record<string, unknown>[]).map((i) => String(i.tag));
  const routing = config.routing as { rules: Record<string, unknown>[] };
  routing.rules = routing.rules.flatMap((rule) => {
    if (!Object.entries(rule).some(([key, v]) => unsupportedSharedFields.has(key) && populated(v)))
      return [rule];
    const tags = (Array.isArray(rule.inboundTag) ? rule.inboundTag.map(String) : allTags).filter(
      (t) => t !== tag,
    );
    return tags.length ? [copyRoutingTrace(rule, { ...rule, inboundTag: tags })] : [];
  });
}

/** One editor transaction. Reuse the unique source and preserve every existing connected path. */
export function configureIcsGraph(
  graph: GraphState,
  sharing: SharingInspection,
  position: RuleNode['position'],
  filtered: boolean,
): GraphState {
  if (!canUseSharing(sharing))
    throw new Error(
      sharing.problem ||
        sharing.lastError?.message ||
        'A supported Windows sharing pair is required.',
    );
  const existing = graph.nodes.filter((n) => n.data.kind === 'ics-tun');
  if (existing.length > 1) throw new Error('Keep only one ICS TUN node.');
  const source = existing[0]
    ? structuredClone(existing[0])
    : makeNode('ics-tun', clearNodePosition(graph.nodes, position));
  source.data.enabled = true;
  source.data.settings = {
    ...source.data.settings,
    publicId: sharing.pair.public.id,
    privateId: sharing.pair.private.id,
    sharingVersion: sharing.version,
  };
  if (!existing.length) source.data.settings.tag = uniqueInboundTag('ics-traffic', graph.nodes);
  const nodes: RuleNode[] = graph.nodes
    .filter((n) => n.id !== source.id)
    .map((n) => ({ ...n, selected: false }));
  source.selected = true;
  nodes.push(source);
  const edges = graph.edges.map((e) => ({ ...e, selected: false }));
  if (!edges.some((e) => e.source === source.id && e.sourceHandle === 'traffic')) {
    const template = makeNode('direct-outbound', {
      x: source.position.x + 650,
      y: source.position.y,
    });
    const direct = nodes.find(
      (n) =>
        n.data.kind === 'direct-outbound' &&
        n.data.settings.icsUpstream === true &&
        directBehavior(n, graph) === directBehavior(template, graph),
    );
    const destination = direct ?? template;
    if (!direct) {
      destination.position = clearNodePosition(nodes, template.position);
      destination.data.label = 'Direct — ICS upstream';
      destination.data.settings.icsUpstream = true;
      destination.data.settings.tag = uniqueOutboundTag('ics-upstream', nodes);
      nodes.push(destination);
    }
    const connect = (from: RuleNode, port: string, to: RuleNode) =>
      edges.push({
        id: crypto.randomUUID(),
        source: from.id,
        sourceHandle: port,
        target: to.id,
        targetHandle: 'in',
        selected: false,
      });
    if (filtered) {
      const filter = makeNode(
        'routing-filter',
        clearNodePosition(nodes, {
          x: source.position.x + 330,
          y: source.position.y,
        }),
      );
      filter.data.label = 'Shared traffic';
      filter.data.settings = tableSettings({
        outputs: [{ id: 'default', name: 'Upstream' }],
        rules: [],
        defaultOutput: 'default',
      });
      nodes.push(filter);
      connect(source, 'traffic', filter);
      connect(filter, 'default', destination);
    } else connect(source, 'traffic', destination);
  }
  if (nodes.length > 500) throw new Error('The graph supports at most 500 nodes.');
  return { ...graph, nodes, edges };
}

export function sharingAction(graph: GraphState) {
  const nodes = graph.nodes.filter((n) => n.data.kind === 'ics-tun');
  if (nodes.length > 1) return 'Resolve duplicate ICS TUN nodes';
  if (!nodes.length) return 'Add ICS TUN';
  if (isDisabledInbound(nodes[0].data)) return 'Enable existing ICS TUN';
  return graph.edges.some((e) => e.source === nodes[0].id && e.sourceHandle === 'traffic')
    ? 'Open ICS TUN'
    : 'Connect ICS TUN';
}

import type { Edge, Node } from '@xyflow/react';
import { virtualDestinations } from './graph/virtualDestinations';
import { importXrayConfig } from './graph/xrayImport';
import { fixXrayCapitalization } from './graph/xrayConfigNames';
import { getDefinition, getOutputPorts, portLabel } from './graph/catalog';
import { sourceConnectionKind } from './graph/connectionTypes';
import { connectionTypes, type ConnectionKind } from './graph/connectionKinds';
import { jsonArray, jsonRecord, parseXrayJson } from './graph/xrayJson';
import type { GraphState, RuleNode } from './graph/types';
import type { UserProtocol } from './users/model';
import type { ViewConnectionKind } from './viewConnections';
import { nodeTypeLabel } from './uiTerms';
import type { RouteDestination } from './routingEditor';
import { specForProtocol } from './graph/protocols';

export interface ViewPort {
  id: string;
  label: string;
  kind: ViewConnectionKind;
}
export type ViewData = {
  title: string;
  subtitle: string;
  category: string;
  facts: [string, string][];
  outputs: ViewPort[];
  hasInput: boolean;
  inputKinds?: ViewConnectionKind[];
  inputs?: ViewPort[];
  userProtocol?: UserProtocol;
  userSetId?: string;
  inboundIndex?: number;
  raw: unknown;
  rules?: Record<string, unknown>[];
  references?: string[];
};
export type ViewNode = Node<ViewData, 'remote'>;
export interface RemoteView {
  graph: GraphState;
  nodes: ViewNode[];
  edges: Edge[];
  original: Record<string, unknown>;
  normalized: Record<string, unknown>;
  notices: string[];
  exactProjection: boolean;
  ruleCount: number;
  pooledOutbounds: number;
}

const array = (value: unknown): unknown[] => (jsonArray(value) ? value : []);
const object = (value: unknown): Record<string, unknown> => (jsonRecord(value) ? value : {});
const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

function sourceFor(node: RuleNode, config: Record<string, unknown>): unknown {
  const id = node.id;
  if (id.startsWith('native-in-')) return array(config.inbounds)[Number(id.slice(10))];
  if (id.startsWith('native-out-')) return array(config.outbounds)[Number(id.slice(11))];
  if (id.startsWith('native-balancer-'))
    return array(object(config.routing).balancers)[Number(id.slice(16))];
  if (id.startsWith('native-resolver-'))
    return array(object(config.dns).servers)[Number(id.slice(16))];
  if (id === 'native-routing') return config.routing ?? {};
  if (id === 'native-dns') return config.dns ?? {};
  if (id === 'native-observatory') return config.observatory ?? config.burstObservatory;
  if (node.data.native) return node.data.native.original;
  return Object.fromEntries(
    Object.entries(config).filter(
      ([key]) =>
        !['inbounds', 'outbounds', 'routing', 'dns', 'observatory', 'burstObservatory'].includes(
          key,
        ),
    ),
  );
}
function facts(raw: unknown, kind: string): [string, string][] {
  const value = object(raw),
    settings = object(value.settings),
    stream = object(value.streamSettings);
  const rows: [string, string][] = [];
  if (value.listen !== undefined || value.port !== undefined)
    rows.push([
      'Listen',
      `${text(value.listen) || 'All addresses'}${value.port !== undefined ? ':' + text(value.port) : ''}`,
    ]);
  if (stream.network || stream.security)
    rows.push([
      'Transport',
      [text(stream.network), text(stream.security)].filter(Boolean).join(' · '),
    ]);
  const clients = array(settings.clients);
  if (clients.length) rows.push(['Accounts', String(clients.length)]);
  const server = object(array(settings.servers)[0] ?? array(settings.vnext)[0]);
  const address = settings.address ?? server.address;
  if (address)
    rows.push([
      'Server',
      `${text(address)}${(settings.port ?? server.port) ? ':' + text(settings.port ?? server.port) : ''}`,
    ]);
  if (kind === 'routing-filter') rows.push(['Rules', String(array(value.rules).length)]);
  if (value.selector) rows.push(['Candidates', array(value.selector).map(text).join(', ')]);
  if (kind === 'observatory')
    rows.push([
      'Probe',
      text(value.probeURL) || text(object(value.pingConfig).destination) || 'Core default',
    ]);
  if (kind === 'xray-dns') rows.push(['Resolvers', String(array(value.servers).length)]);
  if (typeof raw === 'string') rows.push(['Address', raw]);
  if (value.address && kind === 'xray-dns-servers') rows.push(['Address', text(value.address)]);
  return rows;
}

function fromGraph(
  graph: GraphState,
  config: Record<string, unknown>,
): { nodes: ViewNode[]; edges: Edge[] } {
  const nodes = graph.nodes.map((node): ViewNode => {
    const definition = getDefinition(node.data.kind),
      raw = sourceFor(node, config);
    const outputs = getOutputPorts(node.data.kind, node.data).map((id) => ({
      id,
      label:
        definition.category === 'inbound' && (id === 'data' || id === 'traffic')
          ? 'Data'
          : portLabel(id, node.data),
      kind: sourceConnectionKind(node.data, id),
    }));
    return {
      id: node.id,
      type: 'remote',
      position: node.position,
      data: {
        title:
          node.id === 'native-options'
            ? 'Core settings'
            : node.id === 'native-routing'
              ? 'Routing filter'
              : node.id === 'native-dns'
                ? text(object(raw).tag) || 'DNS handler'
                : node.id.startsWith('native-in-') && !object(raw).tag
                  ? `${node.data.label || definition.title} · ${text(object(raw).port) || Number(node.id.slice(10)) + 1}`
                  : node.data.label || definition.title,
        subtitle: nodeTypeLabel(node.data.kind, text(object(raw).protocol)),
        category: definition.category,
        facts: facts(raw, node.data.kind),
        outputs,
        hasInput: graph.edges.some((e) => e.target === node.id),
        raw,
        ...(node.data.kind === 'routing-filter'
          ? { rules: array(object(raw).rules).map(object) }
          : {}),
      },
    };
  });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges.map((edge) => {
    const source = byId.get(edge.source)!;
    return styleEdge(edge, sourceConnectionKind(source.data, edge.sourceHandle ?? 'traffic'));
  });
  return { nodes, edges };
}
function styleEdge(edge: Edge, kind: ConnectionKind): Edge {
  const style = connectionTypes[kind];
  return {
    ...edge,
    type: 'schematic',
    style: { stroke: style.color, strokeWidth: 1.8, strokeDasharray: style.dash },
    data: { connectionKind: kind },
    label: undefined,
  };
}

export function unplacedOutbounds(view: RemoteView, shown: readonly string[] = []): ViewNode[] {
  const outboundIds = new Set(
    view.nodes.filter((node) => node.id.startsWith('native-out-')).map((node) => node.id),
  );
  const routed = new Set(shown);
  const dependencies = new Map<string, string[]>();
  for (const edge of view.edges) {
    if (!outboundIds.has(edge.source)) routed.add(edge.target);
    else {
      const targets = dependencies.get(edge.source) ?? [];
      targets.push(edge.target);
      dependencies.set(edge.source, targets);
    }
  }
  // A dial-through dependency belongs on the canvas when its caller is routed.
  for (const id of routed) for (const target of dependencies.get(id) ?? []) routed.add(target);
  return view.nodes.filter((node) => outboundIds.has(node.id) && !routed.has(node.id));
}

/** A view adapter, never an executable profile. Source bytes remain in the snapshot. */
export function remoteView(source: string, savedGraph?: GraphState): RemoteView {
  const original = parseXrayJson(source);
  if (!jsonRecord(original))
    throw new Error('The remote file must contain a complete Xray JSON object.');
  const corrected = fixXrayCapitalization(source);
  const normalized = object(parseXrayJson(corrected.text));
  const notices = corrected.changes.length
    ? [
        `${corrected.changes.length} field names use noncanonical capitalization. The graph uses canonical names; the remote file is unchanged.`,
      ]
    : [];
  const graph =
    savedGraph ?? importXrayConfig(JSON.stringify(normalized), 'Remote Xray configuration');
  const view = fromGraph(graph, normalized);
  const endpoints = virtualDestinations(normalized.api, normalized.inbounds);
  for (const node of view.nodes) {
    const endpoint = endpoints.get(node.data.title);
    if (endpoint?.id !== node.id) continue;
    node.data.category = 'internal';
    node.data.subtitle = endpoint.title;
    node.data.raw = endpoint.raw;
    if (node.id === 'remote-api')
      node.data.facts = [['Services', array(endpoint.raw.services).map(text).join(', ')]];
  }
  // Represent explicit outbound dial-through dependencies as distinct dotted links.
  const outbounds = array(normalized.outbounds).map(object);
  for (const { id, config } of graph.xray?.outboundPool ?? []) {
    const index = Number(id.slice(11));
    view.nodes.push({
      id,
      type: 'remote',
      position: { x: 1080 + Math.floor(index / 64) * 400, y: (index % 64) * 205 },
      data: {
        title: text(config.tag) || `Outbound ${index + 1}`,
        subtitle: specForProtocol(config.protocol, 'outbound')?.title || 'Outbound',
        category: 'outbound',
        facts: facts(config, 'xray-outbound'),
        outputs: [],
        hasInput: false,
        raw: config,
      },
    });
  }
  const groups = array(object(normalized.routing).balancers).map(object);
  const observer = object(normalized.observatory ?? normalized.burstObservatory);
  const matches = (selectors: unknown, tag: string) =>
    !!tag &&
    array(selectors).some((prefix) => typeof prefix === 'string' && tag.startsWith(prefix));
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const byTag = new Map(
    outbounds.flatMap((outbound, index) =>
      typeof outbound.tag === 'string' ? [[outbound.tag, index] as const] : [],
    ),
  );
  for (const [index, outbound] of outbounds.entries()) {
    const node = byId.get(`native-out-${index}`);
    if (!node) continue;
    const tag = text(outbound.tag);
    node.data.references = [
      ...(node.data.references ?? []),
      ...groups.flatMap((group) => [
        ...(matches(group.selector, tag) ? [`Candidate · ${text(group.tag)}`] : []),
        ...(tag && group.fallbackTag === tag ? [`Fallback · ${text(group.tag)}`] : []),
      ]),
    ];
    if (matches(observer.subjectSelector, tag)) node.data.references.push('Observatory');
    const targetTag =
      text(object(outbound.proxySettings).tag) ||
      text(object(object(outbound.streamSettings).sockopt).dialerProxy);
    const targetIndex = byTag.get(targetTag);
    if (!targetTag || targetIndex === undefined) continue;
    const target = byId.get(`native-out-${targetIndex}`);
    if (target) {
      target.data.references ??= [];
      target.data.references.push(`Dial-through · ${node.data.title}`);
      node.data.outputs.push({ id: 'dial-through', label: 'Via ' + targetTag, kind: 'traffic' });
      target.data.hasInput = true;
      view.edges.push({
        ...styleEdge(
          {
            id: `via-${index}`,
            source: node.id,
            sourceHandle: 'dial-through',
            target: target.id,
            targetHandle: 'in',
          },
          'traffic',
        ),
        style: { stroke: connectionTypes.traffic.color, strokeWidth: 1.8, strokeDasharray: '3 5' },
      });
    }
  }
  const pooledOutbounds = graph.xray?.outboundPool?.length ?? 0;
  for (const edge of view.edges) {
    const target = byId.get(edge.target);
    const kind = edge.data?.connectionKind as ConnectionKind | undefined;
    if (target && kind) {
      target.data.inputKinds ??= [];
      if (!target.data.inputKinds.includes(kind)) target.data.inputKinds.push(kind);
    }
  }
  return {
    ...view,
    graph,
    original,
    normalized,
    notices,
    exactProjection: !corrected.changes.length,
    ruleCount: array(object(normalized.routing).rules).length,
    pooledOutbounds,
  };
}

const sensitiveKey =
  /^(?:id|uuid|password|passwd|pass|auth|key|privatekey|secretkey|presharedkey|publickey|shortids?|.*token|.*api[-_]?key|authorization|cookie|encryption|decryption|email|username|user)$/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username) url.username = 'hidden';
      if (url.password) url.password = 'hidden';
      for (const key of url.searchParams.keys())
        if (sensitiveKey.test(key)) url.searchParams.set(key, 'hidden');
      return url.href;
    } catch {
      return value;
    }
  }
  if (!jsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, content]) => [
      key,
      sensitiveKey.test(key) ? '[hidden]' : redact(content),
    ]),
  );
}

export function ruleConditions(rule: Record<string, unknown>): string {
  const conditions = Object.entries(rule).filter(
    ([key]) => !['type', 'outboundTag', 'balancerTag', 'ruleTag'].includes(key),
  );
  return conditions.length
    ? conditions
        .map(
          ([key, val]) =>
            `${key}: ${Array.isArray(val) ? val.map((item: unknown) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ') : typeof val === 'object' ? JSON.stringify(val) : typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? String(val) : ''}`,
        )
        .join(' · ')
    : 'All traffic';
}

/** Sources and DNS handlers are routing conditions, never next-hop destinations. */
export function routingDestinations(view: RemoteView): RouteDestination[] {
  return view.nodes.flatMap(({ id, data }) =>
    (id.startsWith('native-out-') ||
      id.startsWith('native-balancer-') ||
      data.category === 'internal') &&
    jsonRecord(data.raw) &&
    typeof data.raw.tag === 'string'
      ? [
          {
            tag: data.raw.tag,
            group: id.startsWith('native-balancer-'),
            internal: data.category === 'internal',
            hidden: id === 'remote-api',
          },
        ]
      : [],
  );
}

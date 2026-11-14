import { graphDependencies } from '../profiles/workspaceDependencies';
import { getDefinition, getOutputPorts, makeNode } from '../graph/catalog';
import { placeholderKind } from '../graph/inboundPlaceholder';
import { remapPreparedSubscriptions } from '../graph/composites';
import { bindingsFor, factoryDefaults } from '../graph/defaults';
import { parsePoolSettings, type PoolSettings } from '../graph/poolSettings';
import { dnsFilterSettings, readDnsFilter } from '../graph/dns';
import { detachDnsSource } from '../graph/dnsRuleSource';
import { bundledExamples, createProxyStarter } from '../graph/examples';
import { isDisabledInbound, isGraphInbound } from '../graph/inboundState';
import { parseGraph, toDocument } from '../graph/model';
import { refreshPolicyGraph, refreshStashComposites } from '../graph/policySources';
import { readRuleTable, tableSettings, type TableRule } from '../graph/rules';
import { detachTrafficSource } from '../graph/trafficRuleSource';
import type { GraphState, NodeKind, RuleEdge, RuleNode } from '../graph/types';
import { generatedTag } from '../graph/tags';
import { jsonRecord } from '../graph/xrayJson';
import {
  parseStash,
  serializeStash,
  type Profile,
  type Stash,
  type StashGroup,
} from '../profiles/import';

const routes = ['data', 'dns', 'sharing', 'nat-data', 'nat-dns', 'encrypted-dns'] as const;
type Route = (typeof routes)[number];
type Routes = Partial<Record<Route, string>>;
export type PoolBindings = Record<string, string>;
export type PoolEntries = {
  name: string;
  settings?: PoolSettings;
  placeholders: { id: string; name: string; ports: string[]; destination?: string }[];
  inbounds: { id: string; name: string; kind: string; endpoint?: string; enabled: boolean }[];
  bindings: PoolBindings;
};
export type PoolCapture = 'current' | 'proxy' | 'tun';
type PoolBundleContent = {
  format: 'wayrill.pool';
  name: string;
  graph: string;
  stash: string;
  settings?: PoolSettings;
};
type LegacyPoolBundle = PoolBundleContent & { version: 1; routes: Routes };
export type PoolBundle = LegacyPoolBundle | (PoolBundleContent & { version: 2 });

const poolGroupPrefix = (recipient: string) => `pool-${recipient}-`;
export const poolGroupId = (recipient: string, groupId: string) =>
  generatedTag(`pool-${recipient}`, groupId);
const dataPort = (kind: NodeKind) => (getOutputPorts(kind).includes('data') ? 'data' : 'traffic');
const sourceNode = (node: RuleNode) =>
  isGraphInbound(node.data.kind) && node.data.kind !== 'ics-tun';

export function poolInputs(graph: GraphState) {
  return graph.nodes.filter(
    (node) =>
      isGraphInbound(node.data.kind) &&
      node.data.kind !== 'xray-inbound' &&
      graph.edges.some(
        (edge) => edge.source === node.id && edge.sourceHandle === dataPort(node.data.kind),
      ),
  );
}

function portableSettings(profile: Profile): Profile {
  const settings = { ...profile.settings };
  for (const key of ['interface', 'sendThrough']) {
    if (Object.hasOwn(settings, key)) settings[key] = '';
  }
  return { ...profile, settings };
}

function portableGroup(group: StashGroup): StashGroup {
  return {
    id: group.id,
    name: group.name,
    url: '',
    headers: {},
    userAgent: '',
    allowHttp: false,
    updatedAt: null,
    entries: group.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      protocol: entry.protocol,
      address: entry.address,
      raw: '',
      profile: entry.profile && portableSettings(entry.profile),
      problem: entry.problem,
      ...(entry.starred ? { starred: true } : {}),
      ...(entry.locked ? { locked: true } : {}),
      ...(entry.draft
        ? { draft: { ...entry.draft, settings: portableSettings(entry.draft).settings } }
        : {}),
    })),
  };
}

export function capturePoolStash(stash: Stash, groupIds: readonly string[]): string {
  const groups = graphDependencies(
    { name: '', nodes: [], edges: [] },
    stash,
    new Set(groupIds),
  ).groups;
  return serializeStash({ ...stash, groups: groups.map(portableGroup) });
}

export function capturePoolBundle(
  name: string,
  workspace: GraphState,
  stash: Stash,
  groupIds: readonly string[],
  inputId: string,
): LegacyPoolBundle {
  if (!name.trim() || name.trim().length > 128) throw new Error('Enter a Pool configuration name.');
  if (workspace.xray)
    throw new Error('Publish a Wayrill routing graph with a local capture input.');
  const host = poolInputs(workspace).find((node) => node.id === inputId && sourceNode(node));
  if (!host) throw new Error('Choose an input connected to the routing path users should receive.');
  const sharing = workspace.nodes.find((node) => node.data.kind === 'ics-tun');
  const roots: Routes = {};
  for (const role of routes) {
    const input = role === 'sharing' ? sharing : host;
    if (!input) continue;
    const port = role === 'data' || role === 'sharing' ? dataPort(input.data.kind) : role;
    const edge = workspace.edges.find(
      (item) => item.source === input.id && item.sourceHandle === port,
    );
    if (edge) roots[role] = edge.target;
  }
  return { ...capturePoolContent(name, workspace, stash, groupIds), version: 1, routes: roots };
}

function capturePoolContent(
  name: string,
  workspace: GraphState,
  stash: Stash,
  groupIds: readonly string[],
): PoolBundleContent {
  if (!name.trim() || name.trim().length > 128) throw new Error('Enter a Pool configuration name.');
  if (workspace.xray) throw new Error('Publish a Wayrill routing graph.');
  const nodes = toDocument(workspace).nodes.filter((node) => !isGraphInbound(node.data.kind));
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const { kind } = node.data;
    const settings = portableSettings(node.data as Profile).settings;
    node.data = {
      ...node.data,
      settings: {
        ...settings,
        ...(kind === 'routing-filter'
          ? tableSettings(publishedTrafficTable(detachTrafficSource(readRuleTable(settings))))
          : {}),
        ...(kind === 'dns-routing-filter'
          ? dnsFilterSettings(detachDnsSource(readDnsFilter(settings)))
          : {}),
      },
      overrides: bindingsFor(kind).map((binding) => binding.nodeKey),
    };
  }
  const graph: GraphState = {
    name: name.trim(),
    nodes,
    edges: workspace.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    mainOutboundId: workspace.mainOutboundId,
    viewport: workspace.viewport,
    defaults: factoryDefaults(),
  };
  const groups = graphDependencies(graph, stash, new Set(groupIds)).groups;
  return {
    format: 'wayrill.pool',
    name: name.trim(),
    graph: JSON.stringify(toDocument(graph)),
    stash: serializeStash({ ...stash, groups: groups.map(portableGroup) }),
  };
}

export function capturePoolGraph(
  name: string,
  workspace: GraphState,
  stash: Stash,
  groupIds: readonly string[],
  inboundIds: readonly string[] = [],
): PoolBundle {
  const chosen = new Set(inboundIds);
  const nodes = workspace.nodes.map((node) => {
    if (!chosen.has(node.id) || !isGraphInbound(node.data.kind)) return node;
    const ports = getOutputPorts(node.data.kind, node.data);
    const placeholder = makeNode(placeholderKind, node.position, node.id);
    placeholder.data.label = node.data.label;
    placeholder.data.settings = {
      dns: ports.includes('dns'),
      encryptedDns: ports.includes('encrypted-dns'),
      nat: ports.includes('nat-data'),
    };
    return placeholder;
  });
  const edges = workspace.edges.map((edge) =>
    chosen.has(edge.source) && edge.sourceHandle === 'traffic'
      ? { ...edge, sourceHandle: 'data' }
      : edge,
  );
  const bundle = {
    ...capturePoolContent(name, { ...workspace, nodes, edges }, stash, groupIds),
    version: 2 as const,
  };
  readPortableGraph(bundle.graph);
  return bundle;
}

export function readPortableGraph(document: string, roles?: Record<string, unknown>) {
  const graph = parseGraph(document);
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (
    graph.xray ||
    graph.captureOptions ||
    graph.nodes.some((node) => isGraphInbound(node.data.kind)) ||
    (roles
      ? graph.nodes.some((node) => node.data.kind === placeholderKind) ||
        typeof roles.data !== 'string' ||
        Object.entries(roles).some(
          ([role, target]) =>
            !routes.includes(role as Route) || typeof target !== 'string' || !ids.has(target),
        )
      : !graph.nodes.some((node) => node.data.kind === placeholderKind))
  )
    throw new Error('Pool graphs must contain portable routing and a valid entry path.');
  if (!roles) {
    if (graph.nodes.some((node) => node.data.kind === placeholderKind && !node.data.label.trim()))
      throw new Error('Name every Inbound Placeholder before publishing.');
    const wired = new Set(
      graph.edges.filter((edge) => edge.sourceHandle === 'data').map((edge) => edge.source),
    );
    if (graph.nodes.some((node) => node.data.kind === placeholderKind && !wired.has(node.id)))
      throw new Error('Connect the Data output of every Inbound Placeholder.');
  }
  return { graph, ids };
}

const legacyHostId = 'pool-legacy-inbound';
const legacySharingId = 'pool-legacy-sharing';

export function editablePoolGraph(bundle: PoolBundle) {
  const result = readPortableGraph(bundle.graph, bundle.version === 1 ? bundle.routes : undefined);
  if (bundle.version === 2) return result;
  const { graph, ids } = result;
  const x = Math.max(-100000, Math.min(0, ...graph.nodes.map((node) => node.position.x)) - 290);
  const host = makeNode(placeholderKind, { x, y: 30 }, legacyHostId);
  host.data.label = 'Subscriber traffic';
  host.data.settings = {
    dns: !!bundle.routes.dns,
    encryptedDns: !!bundle.routes['encrypted-dns'],
    nat: !!(bundle.routes['nat-data'] || bundle.routes['nat-dns']),
  };
  const sharing = makeNode(placeholderKind, { x, y: 310 }, legacySharingId);
  sharing.data.label = 'Subscriber shared traffic';
  sharing.data.settings.dns = false;
  const placeholders = bundle.routes.sharing ? [host, sharing] : [host];
  if (placeholders.some((node) => ids.has(node.id)))
    throw new Error('An existing node uses a reserved Pool placeholder identity.');
  return {
    graph: {
      ...graph,
      nodes: [...placeholders, ...graph.nodes],
      edges: [
        ...graph.edges,
        ...Object.entries(bundle.routes).map(([role, target]) => ({
          id: crypto.randomUUID(),
          source: role === 'sharing' ? sharing.id : host.id,
          sourceHandle: role === 'sharing' ? 'data' : role,
          target,
          targetHandle: 'in',
        })),
      ],
    },
    ids,
  };
}

function localPoolInputs(local: GraphState | undefined, capture: PoolCapture) {
  const device =
    capture === 'tun'
      ? bundledExamples.find((item) => item.id === 'tun')!.create()
      : capture === 'proxy' || !local
        ? createProxyStarter()
        : local;
  const inputs = device.nodes.filter((node) => isGraphInbound(node.data.kind));
  if (
    !inputs.some((node) => sourceNode(node) && !isDisabledInbound(node.data)) ||
    inputs.some((node) => node.data.kind === 'xray-inbound' || node.data.native)
  )
    throw new Error('Choose a Wayrill capture setup with at least one enabled local inbound.');
  return { device, inputs };
}

function defaultPoolBindings(
  graph: GraphState,
  inputs: RuleNode[],
  allowSingle = false,
): PoolBindings {
  const placeholders = graph.nodes.filter((node) => node.data.kind === placeholderKind);
  const host =
    placeholders.find((node) => node.id === legacyHostId)?.id ??
    (allowSingle && placeholders.length === 1 ? placeholders[0].id : undefined);
  const sharing = placeholders.find((node) => node.id === legacySharingId)?.id ?? host;
  return Object.fromEntries(
    inputs.flatMap((node) => {
      const id = node.data.kind === 'ics-tun' ? sharing : host;
      return id ? [[node.id, id]] : [];
    }),
  );
}

export function inspectPoolEntries(
  bundle: PoolBundle,
  local: GraphState | undefined,
  capture: PoolCapture,
  bindings?: PoolBindings,
): PoolEntries {
  const { graph } = editablePoolGraph(bundle);
  const { inputs } = localPoolInputs(local, capture);
  const labels = new Map(graph.nodes.map(({ id, data }) => [id, data.label]));
  return {
    name: bundle.name,
    settings: bundle.settings,
    placeholders: graph.nodes
      .filter((node) => node.data.kind === placeholderKind)
      .map((node) => {
        const paths = graph.edges.filter((edge) => edge.source === node.id);
        const data = paths.find((edge) => edge.sourceHandle === 'data');
        return {
          id: node.id,
          name: node.data.label,
          ports: paths.map((edge) => edge.sourceHandle!),
          destination: data && labels.get(data.target),
        };
      }),
    inbounds: inputs.map((node) => ({
      id: node.id,
      name: node.data.label,
      kind: getDefinition(node.data.kind).title,
      ...(typeof node.data.settings.listen === 'string' &&
      typeof node.data.settings.port === 'number'
        ? { endpoint: `${node.data.settings.listen} · port ${node.data.settings.port}` }
        : {}),
      enabled: !isDisabledInbound(node.data),
    })),
    bindings: bindings ?? defaultPoolBindings(graph, inputs, true),
  };
}

function resolvePoolBindings(graph: GraphState, inputs: RuleNode[], bindings: PoolBindings) {
  const placeholders = new Map(
    graph.nodes.filter((node) => node.data.kind === placeholderKind).map((node) => [node.id, node]),
  );
  const inboundIds = new Set(inputs.map((node) => node.id));
  if (Object.keys(bindings).some((id) => !inboundIds.has(id)))
    throw new Error('A local inbound was removed. Edit inbound assignments in Connect to Pool.');
  const paths = new Map(
    graph.edges.map((edge) => [JSON.stringify([edge.source, edge.sourceHandle]), edge.target]),
  );
  return inputs.flatMap((node): RuleEdge[] => {
    const placeholder = placeholders.get(Object.hasOwn(bindings, node.id) ? bindings[node.id] : '');
    if (!placeholder) {
      if (!isDisabledInbound(node.data) || Object.hasOwn(bindings, node.id))
        throw new Error(
          `Choose an Inbound Placeholder for ${node.data.label}. Edit inbound assignments in Connect to Pool.`,
        );
      return [];
    }
    const target = (port: string) => paths.get(JSON.stringify([placeholder.id, port]));
    return getOutputPorts(node.data.kind, node.data).map((port) => {
      const role = port === dataPort(node.data.kind) ? 'data' : port;
      const destination =
        target(role) ?? (role === 'nat-dns' ? target('dns') : undefined) ?? target('data');
      if (!destination) throw new Error(`Connect the Data output of ${placeholder.data.label}.`);
      return {
        id: generatedTag('pool-edge', JSON.stringify([node.id, port])),
        source: node.id,
        sourceHandle: port,
        target: destination,
        targetHandle: 'in',
      };
    });
  });
}

export function parsePoolBundle(value: unknown): PoolBundle {
  if (
    !jsonRecord(value) ||
    value.format !== 'wayrill.pool' ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 128 ||
    typeof value.graph !== 'string' ||
    typeof value.stash !== 'string' ||
    (value.version === 1 && !jsonRecord(value.routes))
  )
    throw new Error('Invalid Wayrill Pool configuration.');
  const settings = parsePoolSettings(value.settings);
  return settings === value.settings
    ? (value as PoolBundle)
    : { ...(value as PoolBundle), settings };
}

export function publishedTrafficTable(table: ReturnType<typeof readRuleTable>) {
  return { ...table, rules: table.rules.filter((rule) => !rule.poolPlacement) };
}

export function personalRoutingState(graph: GraphState) {
  return graph.nodes.flatMap(({ id, data }) => {
    if (data.kind !== 'routing-filter') return [];
    const rules = readRuleTable(data.settings).rules.filter((rule) => rule.poolPlacement);
    return rules.length ? [{ id, rules }] : [];
  });
}

export function poolRoutingState(graph: GraphState) {
  // Device defaults, listener settings and canvas layout belong to the subscriber.
  // Connections remain managed, including the paths from local inbounds.
  const { nodes, edges, mainOutboundId } = toDocument({ ...graph, defaults: factoryDefaults() });
  return {
    mainOutboundId,
    nodes: nodes
      .filter(({ data }) => !isGraphInbound(data.kind))
      .map(({ id, data }) => {
        if (data.kind !== 'routing-filter') return { id, data };
        const table = readRuleTable(data.settings);
        if (!table.rules.some((rule) => rule.poolPlacement)) return { id, data };
        return {
          id,
          data: {
            ...data,
            settings: {
              ...data.settings,
              rules: JSON.stringify(publishedTrafficTable(table).rules),
            },
          },
        };
      }),
    edges: edges.map(({ source, sourceHandle, target, targetHandle }) => [
      source,
      sourceHandle,
      target,
      targetHandle,
    ]),
  };
}

function mergePersonalRules(shared: GraphState, local: GraphState | undefined) {
  const personal = new Map<
    string,
    { name: string; rules: TableRule[]; outputs: Map<string, string> }
  >();
  for (const node of local?.nodes ?? []) {
    if (node.data.kind !== 'routing-filter') continue;
    const table = readRuleTable(node.data.settings);
    const rules = table.rules.filter((rule) => rule.poolPlacement);
    if (rules.length)
      personal.set(node.id, {
        name: node.data.label,
        rules,
        outputs: new Map(table.outputs.map(({ id, name }) => [id, name])),
      });
  }
  const nodes = shared.nodes.map((node) => {
    if (node.data.kind !== 'routing-filter') return node;
    const overrides = personal.get(node.id);
    const published = readRuleTable(node.data.settings);
    const table = publishedTrafficTable(published);
    if (!overrides && table.rules.length === published.rules.length) return node;
    if (overrides) {
      const outputs = new Set(table.outputs.map(({ id }) => id));
      const connected = new Set(
        shared.edges.filter((edge) => edge.source === node.id).map((edge) => edge.sourceHandle),
      );
      const ids = new Set(table.rules.map(({ id }) => id));
      for (const rule of overrides.rules) {
        if (!outputs.has(rule.output) || !connected.has(rule.output))
          throw new Error(
            `Personal rule “${rule.name}” in “${overrides.name}” uses unavailable output “${overrides.outputs.get(rule.output) ?? rule.output}”. Edit the applied filter’s personal rules and check again.`,
          );
        if (ids.has(rule.id))
          throw new Error(
            `A published rule conflicts with personal rule “${rule.name}” in “${overrides.name}”. Resolve the conflict before updating.`,
          );
      }
      table.rules.push(...overrides.rules);
      personal.delete(node.id);
    }
    return {
      ...node,
      data: { ...node.data, settings: { ...node.data.settings, ...tableSettings(table) } },
    };
  });
  const removed = personal.values().next().value;
  if (removed)
    throw new Error(
      `The Pool graph no longer contains “${removed.name}”, which has personal rules. Review the applied filter before checking again.`,
    );
  return { ...shared, nodes };
}

export function preparePoolWorkspace(
  value: unknown,
  local: GraphState | undefined,
  stash: Stash,
  recipient: string,
  capture: PoolCapture,
  bindings?: PoolBindings,
) {
  const bundle = parsePoolBundle(value);
  const { graph: portable, ids: sharedIds } = editablePoolGraph(bundle);
  const shared = mergePersonalRules(portable, local?.poolId === recipient ? local : undefined);
  const placeholders = new Set(
    shared.nodes.filter((node) => node.data.kind === placeholderKind).map((node) => node.id),
  );
  const sharedStash = parseStash(bundle.stash);
  const { device, inputs } = localPoolInputs(local, capture);
  if (inputs.some((node) => sharedIds.has(node.id) && !placeholders.has(node.id)))
    throw new Error('A Pool node conflicts with a local capture node.');
  const assigned =
    bindings ??
    (bundle.version === 1 || local?.poolId === recipient
      ? defaultPoolBindings(shared, inputs)
      : {});
  const localEdges = resolvePoolBindings(shared, inputs, assigned);
  const prefix = poolGroupPrefix(recipient);
  // A policy can retain a source after its subscription has been removed. Its
  // cached candidates must never start following a similarly named local group.
  const linkedGroups = { get: (id: string) => poolGroupId(recipient, id) };
  const groups = sharedStash.groups.map((source) => {
    const group = portableGroup(source);
    return {
      ...group,
      id: linkedGroups.get(group.id),
      name: `Pool · ${group.name}`.slice(0, 128),
      entries: group.entries.map((entry) => ({
        ...entry,
        profile: entry.profile && remapPreparedSubscriptions(entry.profile, linkedGroups),
        ...(entry.draft
          ? {
              draft: {
                ...entry.draft,
                settings: remapPreparedSubscriptions(entry.draft, linkedGroups).settings,
              },
            }
          : {}),
      })),
    };
  });
  const nodes = [
    ...inputs,
    ...shared.nodes
      .filter((node) => node.data.kind !== placeholderKind)
      .map((node) => {
        const { stashLink } = node.data;
        const data = { ...node.data };
        delete data.poolOutbound;
        const groupId = stashLink && linkedGroups.get(stashLink.groupId);
        return {
          ...node,
          data: {
            ...data,
            settings: remapPreparedSubscriptions(node.data as Profile, linkedGroups).settings,
            ...(stashLink && groupId ? { stashLink: { ...stashLink, groupId } } : {}),
          },
        };
      }),
  ];
  const graph = parseGraph(
    JSON.stringify(
      toDocument({
        name: bundle.name,
        poolId: recipient,
        poolSettings: bundle.settings,
        defaults: device.defaults ?? factoryDefaults(),
        captureOptions: device.captureOptions,
        mainOutboundId: shared.mainOutboundId,
        nodes,
        edges: [...shared.edges.filter((edge) => !placeholders.has(edge.source)), ...localEdges],
      }),
    ),
  );
  const managed = refreshStashComposites({ ...sharedStash, groups });
  return {
    name: bundle.name,
    bindings: assigned,
    graph: refreshPolicyGraph(graph, managed),
    stash: {
      ...stash,
      groups: [...stash.groups.filter((group) => !group.id.startsWith(prefix)), ...managed.groups],
    },
  };
}

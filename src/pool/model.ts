import { graphDependencies } from '../profiles/workspaceDependencies';
import { graphPoolApplications } from '../graph/poolApplicationGraph';
import {
  updatePoolApplicationBindings,
  type PoolApplicationBinding,
  type PoolApplicationChanges,
  type PoolApplicationIdentity,
} from '../graph/applications';
import { withoutPreferences } from './preferences';
import { getDefinition, getOutputPorts, makeNode } from '../graph/catalog';
import {
  capturePlaceholder,
  placeholderKind,
  type CapturePlaceholder,
} from '../graph/inboundPlaceholder';
import { remapPreparedSubscriptions } from '../graph/composites';
import { commitEditorDraft } from '../graph/editorDraft';
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
import type { GraphState, NodeKind, PoolGraphLink, RuleEdge, RuleNode } from '../graph/types';
import { generatedTag } from '../graph/tags';
import { jsonEqual, jsonRecord } from '../graph/xrayJson';
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
  applications: (PoolApplicationIdentity & { binding?: PoolApplicationBinding })[];
  placeholders: { id: string; name: string; ports: string[]; destination?: string }[];
  inbounds: {
    id: string;
    name: string;
    kind: string;
    endpoint?: string;
    enabled: boolean;
    targets: string[];
  }[];
  bindings: PoolBindings;
};
export type PoolCapture = 'current' | 'proxy' | 'tun' | 'both';
type PoolBundleContent = {
  format: 'wayrill.pool';
  name: string;
  graph: string;
  stash: string;
  settings?: PoolSettings;
};
type LegacyPoolBundle = PoolBundleContent & { version: 1; routes: Routes };
export type PoolBundle =
  LegacyPoolBundle | (PoolBundleContent & { version: 2 | 3; linkedLayers?: PoolGraphLink[] });

const poolGroupPrefix = (recipient: string) => `pool-${recipient}-`;
export const poolGroupId = (recipient: string, groupId: string) =>
  generatedTag(`pool-${recipient}`, groupId);
const dataPort = (kind: NodeKind) => (getOutputPorts(kind).includes('data') ? 'data' : 'traffic');
const sourceNode = (node: RuleNode) =>
  isGraphInbound(node.data.kind) && node.data.kind !== 'ics-tun';
const captureKinds = ['proxy', 'tun'] as const;
const inputCapture = (kind: NodeKind): CapturePlaceholder | undefined =>
  kind === 'proxy-inbound' ? 'proxy' : kind === 'tun-inbound' ? 'tun' : undefined;
const allowsBinding = (placeholder: RuleNode, input: RuleNode) =>
  !capturePlaceholder(placeholder.data) ||
  capturePlaceholder(placeholder.data) === inputCapture(input.data.kind);

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
  const converted = new Set(workspace.nodes.flatMap((node) => capturePlaceholder(node.data) ?? []));
  const nodes = workspace.nodes.map((node) => {
    if (!chosen.has(node.id) || !isGraphInbound(node.data.kind)) return node;
    const ports = getOutputPorts(node.data.kind, node.data);
    const placeholder = makeNode(placeholderKind, node.position, node.id);
    const captureKind = inputCapture(node.data.kind);
    const distinct = captureKind && !converted.has(captureKind) ? captureKind : undefined;
    if (distinct) converted.add(distinct);
    placeholder.data.label = distinct ? captureLabel(distinct) : node.data.label;
    placeholder.data.settings = {
      captureKind: distinct ?? 'any',
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
  const draft = { ...workspace, nodes, edges };
  const graph = inboundIds.length ? ensurePoolCapture(draft) : draft;
  const bundle = { ...capturePoolContent(name, graph, stash, groupIds), version: 3 as const };
  readPortableGraph(bundle.graph, undefined, true);
  return bundle;
}

const captureLabel = (kind: CapturePlaceholder) =>
  kind === 'proxy' ? 'Proxy capture' : 'TUN capture';

// Keep existing IDs and paths when editing older templates. Newly generated
// entries get stable IDs so a later publication does not reset assignments.
export function ensurePoolCapture(graph: GraphState): GraphState {
  const placeholders = graph.nodes.filter((node) => node.data.kind === placeholderKind);
  const dataSources = new Set(
    graph.edges.filter((edge) => edge.sourceHandle === 'data').map((edge) => edge.source),
  );
  const original = placeholders.find((node) => dataSources.has(node.id));
  if (!original) return graph;
  const used = new Set(graph.nodes.map((node) => node.id));
  const missing = captureKinds.filter(
    (kind) => !placeholders.some((node) => capturePlaceholder(node.data) === kind),
  );
  const additions = missing.map((kind, index) => {
    const stableId = `pool-${kind}-capture`;
    let id = stableId;
    for (let suffix = 2; used.has(id); suffix++) id = `${stableId}-${suffix}`;
    used.add(id);
    const node = makeNode(
      placeholderKind,
      {
        x: original.position.x,
        y: Math.max(...placeholders.map(({ position }) => position.y)) + 260 * (index + 1),
      },
      id,
    );
    node.data.label = captureLabel(kind);
    node.data.settings.captureKind = kind;
    node.data.settings.dns = !!original.data.settings.dns;
    return node;
  });
  if (!additions.length) return graph;
  return {
    ...graph,
    nodes: [...graph.nodes, ...additions],
    edges: [
      ...graph.edges,
      ...additions.flatMap((node) =>
        graph.edges
          .filter(
            (edge) => edge.source === original.id && ['data', 'dns'].includes(edge.sourceHandle!),
          )
          .map((edge) => ({ ...edge, id: crypto.randomUUID(), source: node.id })),
      ),
    ],
  };
}

export function readPortableGraph(
  document: string,
  roles?: Record<string, unknown>,
  dedicatedCapture = false,
) {
  const graph = parseGraph(document);
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (
    graph.xray ||
    graph.poolId ||
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
    const placeholders = graph.nodes.filter((node) => node.data.kind === placeholderKind);
    if (
      dedicatedCapture &&
      captureKinds.some(
        (kind) =>
          placeholders.filter((node) => capturePlaceholder(node.data) === kind).length !== 1,
      )
    )
      throw new Error('Include exactly one Proxy and one TUN Inbound Placeholder.');
    if (placeholders.some((node) => !node.data.label.trim()))
      throw new Error('Name every Inbound Placeholder before publishing.');
    const wired = new Set(
      graph.edges.filter((edge) => edge.sourceHandle === 'data').map((edge) => edge.source),
    );
    if (placeholders.some((node) => !wired.has(node.id)))
      throw new Error('Connect the Data output of every Inbound Placeholder.');
  }
  return { graph, ids };
}

const legacyHostId = 'pool-legacy-inbound';
const legacySharingId = 'pool-legacy-sharing';

export function editablePoolGraph(bundle: PoolBundle) {
  const result = readPortableGraph(
    bundle.graph,
    bundle.version === 1 ? bundle.routes : undefined,
    bundle.version === 3,
  );
  if (bundle.version !== 1) return result;
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
  if (capture === 'current' && !local)
    throw new Error('There are no applied inbounds on this computer. Choose Proxy, TUN or Both.');
  const proxy = () => createProxyStarter();
  const tun = () => bundledExamples.find((item) => item.id === 'tun')!.create();
  const device = capture === 'tun' ? tun() : capture === 'current' && local ? local : proxy();
  if (capture === 'both') {
    const input = tun().nodes.find((node) => node.data.kind === 'tun-inbound')!;
    device.nodes.push({ ...input, position: { x: input.position.x, y: input.position.y + 260 } });
  }
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
  preferLegacy = false,
): PoolBindings {
  const placeholders = graph.nodes.filter((node) => node.data.kind === placeholderKind);
  const host =
    placeholders.find((node) => node.id === legacyHostId)?.id ??
    (allowSingle && placeholders.length === 1 ? placeholders[0].id : undefined);
  const sharing = placeholders.find((node) => node.id === legacySharingId)?.id ?? host;
  return Object.fromEntries(
    inputs.flatMap((node) => {
      const capture = inputCapture(node.data.kind);
      const dedicated =
        capture && placeholders.find((item) => capturePlaceholder(item.data) === capture);
      const previous = node.data.kind === 'ics-tun' ? sharing : host;
      const id = preferLegacy && previous ? previous : dedicated ? dedicated.id : previous;
      return id ? [[node.id, id]] : [];
    }),
  );
}

export function inspectPoolEntries(
  bundle: PoolBundle,
  local: GraphState | undefined,
  capture: PoolCapture,
  bindings?: PoolBindings,
  recipient?: string,
): PoolEntries {
  const { graph } = editablePoolGraph(bundle);
  const { inputs } = localPoolInputs(local, capture);
  const labels = new Map(graph.nodes.map(({ id, data }) => [id, data.label]));
  const placeholders = graph.nodes.filter((node) => node.data.kind === placeholderKind);
  return {
    name: bundle.name,
    settings: bundle.settings,
    applications: graphPoolApplications(graph).map((app) => ({
      ...app,
      binding: local?.poolId === recipient ? local?.poolApplicationBindings?.[app.id] : undefined,
    })),
    placeholders: placeholders.map((node) => {
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
      targets: placeholders
        .filter((placeholder) => allowsBinding(placeholder, node))
        .map(({ id }) => id),
    })),
    bindings: bindings ?? defaultPoolBindings(graph, inputs, true),
  };
}

function resolvePoolBindings(
  graph: GraphState,
  inputs: RuleNode[],
  bindings: PoolBindings,
  previous?: GraphState,
) {
  const placeholders = new Map(
    graph.nodes.filter((node) => node.data.kind === placeholderKind).map((node) => [node.id, node]),
  );
  const inboundIds = new Set(inputs.map((node) => node.id));
  if (!previous && Object.keys(bindings).some((id) => !inboundIds.has(id)))
    throw new Error('A local inbound was removed. Edit inbound assignments in Connect to Pool.');
  const paths = new Map(
    graph.edges.map((edge) => [JSON.stringify([edge.source, edge.sourceHandle]), edge.target]),
  );
  const assigned: PoolBindings = Object.fromEntries(
    Object.entries(bindings).filter(([id]) => inboundIds.has(id)),
  );
  const previousPaths = new Map(
    previous?.edges.map((edge) => [JSON.stringify([edge.source, edge.sourceHandle]), edge.target]),
  );
  const destinationFor = (slot: string, kind: NodeKind, port: string) => {
    const role = port === dataPort(kind) ? 'data' : port;
    const target = (role: string) => paths.get(JSON.stringify([slot, role]));
    return target(role) ?? (role === 'nat-dns' ? target('dns') : undefined) ?? target('data');
  };
  const edges = inputs.flatMap((node): RuleEdge[] => {
    const assignedId = Object.hasOwn(assigned, node.id) ? assigned[node.id] : '';
    let placeholder = placeholders.get(assignedId);
    const ports = getOutputPorts(node.data.kind, node.data);
    if (previous && assignedId && !placeholder) {
      // Only repair an identity change if every port still reaches the same
      // node of the same kind. Never guess between two plausible capture paths.
      const equivalent = [...placeholders.values()].filter(
        (slot) =>
          allowsBinding(slot, node) &&
          ports.every((port) => {
            const old = previousPaths.get(JSON.stringify([node.id, port]));
            return (
              old &&
              old === destinationFor(slot.id, node.data.kind, port) &&
              previous.nodes.find((n) => n.id === old)?.data.kind ===
                graph.nodes.find((n) => n.id === old)?.data.kind
            );
          }),
      );
      if (equivalent.length === 1) {
        placeholder = equivalent[0];
        assigned[node.id] = placeholder.id;
      }
    }
    if (!placeholder || !allowsBinding(placeholder, node)) {
      if (!isDisabledInbound(node.data) || Object.hasOwn(bindings, node.id))
        throw new Error(
          `Choose an Inbound Placeholder for ${node.data.label}. Edit inbound assignments in Connect to Pool.`,
        );
      return [];
    }
    const slot = placeholder;
    return ports.map((port) => {
      const destination = destinationFor(slot.id, node.data.kind, port);
      if (!destination) throw new Error(`Connect the Data output of ${slot.data.label}.`);
      return {
        id: generatedTag('pool-edge', JSON.stringify([node.id, port])),
        source: node.id,
        sourceHandle: port,
        target: destination,
        targetHandle: 'in',
      };
    });
  });
  return { edges, assigned };
}

export function parsePoolBundle(value: unknown): PoolBundle {
  if (
    !jsonRecord(value) ||
    value.format !== 'wayrill.pool' ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 128 ||
    typeof value.graph !== 'string' ||
    typeof value.stash !== 'string' ||
    (value.version === 1 && !jsonRecord(value.routes)) ||
    (value.linkedLayers !== undefined &&
      (value.version === 1 ||
        !Array.isArray(value.linkedLayers) ||
        !value.linkedLayers.every(
          (link: unknown) =>
            jsonRecord(link) &&
            typeof link.id === 'string' &&
            (link.target === undefined || typeof link.target === 'string'),
        )))
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

export function poolRoutingState(graph: GraphState, layerPreferences = false) {
  // Device defaults, listener settings and canvas layout belong to the subscriber.
  // Connections remain managed, including the paths from local inbounds.
  const { nodes, edges, mainOutboundId } = toDocument({ ...graph, defaults: factoryDefaults() });
  return {
    mainOutboundId,
    nodes: nodes
      .filter(({ data }) => !isGraphInbound(data.kind))
      .map(({ id, data: original }) => {
        const data = layerPreferences ? withoutPreferences(original) : original;
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

export function followPoolGraph(
  applied: GraphState,
  draft: GraphState,
  previous?: GraphState,
): GraphState {
  if (draft.poolId !== applied.poolId) return applied;
  if (!previous || previous.poolId !== applied.poolId) return withPoolLayout(applied, draft);
  const base = previous;
  const content = (graph: GraphState): GraphState => {
    const document = toDocument(mergePersonalRules(graph, undefined));
    delete document.viewport;
    return {
      ...document,
      nodes: document.nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } })),
    };
  };
  const merged = commitEditorDraft(content(base), content(draft), content(applied));
  const keepDraftRules = !jsonEqual(personalRoutingState(draft), personalRoutingState(base));
  const graph = mergePersonalRules(merged, keepDraftRules ? draft : applied);
  return withPoolLayout(graph, draft, applied);
}

function withPoolLayout(graph: GraphState, draft: GraphState, applied = graph): GraphState {
  const localNodes = new Map(draft.nodes.map((node) => [node.id, node]));
  const localEdges = new Map(draft.edges.map((edge) => [edge.id, edge]));
  const appliedNodes = new Map(applied.nodes.map((node) => [node.id, node]));
  return {
    ...graph,
    viewport: draft.viewport ?? applied.viewport,
    nodes: graph.nodes.map((node) => {
      const local = localNodes.get(node.id);
      return {
        ...node,
        position: local?.position ?? appliedNodes.get(node.id)!.position,
        selected: local?.selected,
      };
    }),
    edges: graph.edges.map((edge) => ({ ...edge, selected: localEdges.get(edge.id)?.selected })),
  };
}

/** Compare the authored graph, independent of viewport, selection and node positions. */
export function samePoolDocument(left: GraphState, right: GraphState): boolean {
  const contents = (graph: GraphState) => {
    const document = toDocument(graph);
    return {
      ...document,
      viewport: undefined,
      nodes: document.nodes.map(({ id, data }) => ({ id, data })),
    };
  };
  return left === right || jsonEqual(contents(left), contents(right));
}

export function preparePoolWorkspace(
  value: unknown,
  local: GraphState | undefined,
  stash: Stash,
  recipient: string,
  capture: PoolCapture,
  bindings?: PoolBindings,
  reconcileBindings = false,
  applicationChanges?: PoolApplicationChanges,
) {
  const bundle = parsePoolBundle(value);
  const { graph: portable, ids: sharedIds } = editablePoolGraph(bundle);
  const shared = mergePersonalRules(portable, local?.poolId === recipient ? local : undefined);
  const allowed = new Set(graphPoolApplications(portable).map(({ id }) => id));
  const applicationBindings = updatePoolApplicationBindings(
    local?.poolId === recipient ? local.poolApplicationBindings : undefined,
    applicationChanges &&
      Object.fromEntries(Object.entries(applicationChanges).filter(([id]) => allowed.has(id))),
  );
  const placeholders = new Set(
    shared.nodes.filter((node) => node.data.kind === placeholderKind).map((node) => node.id),
  );
  const sharedStash = parseStash(bundle.stash);
  const { device, inputs } = localPoolInputs(local, capture);
  if (inputs.some((node) => sharedIds.has(node.id) && !placeholders.has(node.id)))
    throw new Error('A Pool node conflicts with a local capture node.');
  const assigned =
    bindings ??
    (bundle.version !== 2 || local?.poolId === recipient
      ? defaultPoolBindings(
          shared,
          inputs,
          false,
          capture === 'current' && local?.poolId === recipient,
        )
      : {});
  const resolved = resolvePoolBindings(
    shared,
    inputs,
    assigned,
    reconcileBindings && local?.poolId === recipient ? local : undefined,
  );
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
        poolApplicationBindings: applicationBindings,
        poolSettings: bundle.settings,
        defaults:
          local?.poolId !== recipient && local?.defaults?.localPoolSettings
            ? { ...local.defaults, localPoolSettings: undefined }
            : (local?.defaults ?? device.defaults ?? factoryDefaults()),
        captureOptions: device.captureOptions,
        mainOutboundId: shared.mainOutboundId,
        nodes,
        edges: [
          ...shared.edges.filter((edge) => !placeholders.has(edge.source)),
          ...resolved.edges,
        ],
      }),
    ),
  );
  const managed = refreshStashComposites({ ...sharedStash, groups });
  return {
    name: bundle.name,
    bindings: resolved.assigned,
    graph: refreshPolicyGraph(graph, managed),
    stash: {
      ...stash,
      groups: [...stash.groups.filter((group) => !group.id.startsWith(prefix)), ...managed.groups],
    },
  };
}

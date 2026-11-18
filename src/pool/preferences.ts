import { getDefinition } from '../graph/catalog';
import { bindingsFor, resolveGraph } from '../graph/defaults';
import { isGraphInbound } from '../graph/inboundState';
import { jsonRecord, parseJson } from '../graph/xrayJson';
import type { GraphState, NodeKind, RuleNodeData, SettingValue } from '../graph/types';

type Values = Record<string, SettingValue | null>;
type Basis = { kind: NodeKind; values: Values; pinned?: string[] };
export type PoolPreferenceBase = Record<string, Basis>;
export type PoolPreferenceResets = Record<string, string[]>;

// A binding is a field the editor already supports inheriting independently.
// Linked and native profiles get their connection settings from their own editors.
const additional: Partial<Record<NodeKind, string[]>> = {
  'dns-handler': [
    'queryStrategy',
    'disableCache',
    'useSystemHosts',
    'clientIP',
    'serveStale',
    'serveExpiredTTL',
  ],
  'dns-routing-filter': ['fallbackMode', 'parallel', 'fallbackFirst'],
  'policy-group': ['expected', 'maxRTT', 'tolerance', 'baselines'],
  observatory: [
    'probeURL',
    'probeInterval',
    'enableConcurrency',
    'destination',
    'connectivity',
    'interval',
    'sampling',
    'timeout',
    'httpMethod',
  ],
};
const schemas = new Map<NodeKind, Map<string, boolean>>();
function schema(data: RuleNodeData) {
  if (data.native || data.stashLink) return undefined;
  let keys = schemas.get(data.kind);
  if (!keys) {
    const bound = new Set(bindingsFor(data.kind).map(({ nodeKey }) => nodeKey));
    keys = new Map();
    for (const { key, type } of getDefinition(data.kind).fields) {
      if (bound.has(key) && type !== 'json' && type !== 'password') keys.set(key, true);
      else if (additional[data.kind]?.includes(key)) keys.set(key, false);
    }
    schemas.set(data.kind, keys);
  }
  return keys;
}

function values(data: RuleNodeData): Values {
  const pairs: [string, SettingValue | null][] = [
    ['label', data.label],
    ['description', data.description],
  ];
  for (const [key, bound] of schema(data) ?? []) {
    if (!bound || data.overrides?.includes(key)) pairs.push([key, data.settings[key] ?? null]);
  }
  if (data.kind === 'dns-handler') {
    for (const [host, target] of hosts(data)) pairs.push(['hosts/' + host, JSON.stringify(target)]);
  }
  return Object.fromEntries(pairs);
}

function hosts(data: RuleNodeData) {
  const parsed = parseJson(String(data.settings.hosts ?? '{}'));
  if (!jsonRecord(parsed)) throw new Error('Static hosts must be a JSON object.');
  return new Map(Object.entries(parsed));
}

export function poolPreferenceBase(graph: GraphState): PoolPreferenceBase {
  return Object.fromEntries(
    graph.nodes
      .filter(({ data }) => !isGraphInbound(data.kind))
      .map(({ id, data }) => [id, { kind: data.kind, values: values(data) }]),
  );
}

/** Everything left here is owned by the publisher, including credentials, routes and rule tables. */
export function withoutPreferences(data: RuleNodeData): RuleNodeData {
  const keys = schema(data);
  return {
    ...data,
    label: '',
    description: '',
    settings: Object.fromEntries(
      Object.entries(data.settings).filter(
        ([key]) => !keys?.has(key) && !(key === 'hosts' && data.kind === 'dns-handler'),
      ),
    ),
    overrides: data.overrides?.filter((key) => !keys?.has(key)),
  };
}

function changedKeys(data: RuleNodeData, previous: Basis) {
  const local = values(data);
  return [...new Set([...Object.keys(previous.values), ...Object.keys(local)])]
    .filter((key) => previous.values[key] !== local[key] || previous.pinned?.includes(key))
    .map((key) => ({ key, value: local[key] }));
}

export function personalSettingChoices(graph?: GraphState, base?: PoolPreferenceBase) {
  if (!base || !graph) return [];
  return graph.nodes.flatMap(({ id, data }) => {
    const previous = Object.hasOwn(base, id) && base[id];
    if (!previous || previous.kind !== data.kind) return [];
    const fields = getDefinition(data.kind).fields;
    return changedKeys(data, previous).map(({ key }) => ({
      nodeId: id,
      node: data.label,
      key,
      field: key.startsWith('hosts/')
        ? 'Static host · ' + key.slice(6)
        : (fields.find((f) => f.key === key)?.label ?? (key === 'label' ? 'Name' : 'Description')),
    }));
  });
}

export function applyPoolPreferences(
  published: GraphState,
  local?: GraphState,
  previous?: PoolPreferenceBase,
  reset?: PoolPreferenceResets,
) {
  const base = poolPreferenceBase(published);
  if (!local || !previous) return { graph: published, base };
  const previousNodes = new Map(local.nodes.map(({ id, data }) => [id, data]));
  const nodes = published.nodes.map((node) => {
    const old = Object.hasOwn(previous, node.id) && previous[node.id];
    const localNode = previousNodes.get(node.id);
    if (!old || old.kind !== node.data.kind || localNode?.kind !== old.kind) return node;
    const keys = schema(node.data);
    const changes = changedKeys(localNode, old).filter(
      ({ key }) =>
        (key === 'label' ||
          key === 'description' ||
          keys?.has(key) ||
          (node.data.kind === 'dns-handler' && key.startsWith('hosts/'))) &&
        !(reset && Object.hasOwn(reset, node.id) && reset[node.id].includes(key)),
    );
    if (!changes.length) return node;
    const data = { ...node.data, settings: { ...node.data.settings } };
    const overrides = new Set(data.overrides);
    const next = base[node.id];
    let editedHosts: ReturnType<typeof hosts> | undefined;
    for (const { key, value } of changes) {
      if (key === 'label' || key === 'description') data[key] = String(value);
      else if (key.startsWith('hosts/')) {
        editedHosts ??= hosts(node.data);
        if (value === undefined) editedHosts.delete(key.slice(6));
        else editedHosts.set(key.slice(6), parseJson(String(value)));
      } else {
        if (value == null) delete data.settings[key];
        else data.settings[key] = value;
        if (keys?.get(key)) {
          if (value === undefined) overrides.delete(key);
          else overrides.add(key);
        }
      }
      // A publisher temporarily choosing the same value must not cancel a user's preference.
      if (next.values[key] === value) (next.pinned ??= []).push(key);
    }
    if (editedHosts) data.settings.hosts = JSON.stringify(Object.fromEntries(editedHosts));
    return { ...node, data: { ...data, overrides: [...overrides] } };
  });
  return { graph: resolveGraph({ ...published, nodes }), base };
}

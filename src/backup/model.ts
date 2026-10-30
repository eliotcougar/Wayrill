import { appVersion } from '../version';
import { parseGraph, toDocument, updateGraphNode } from '../graph/model';
import { factoryDefaults } from '../graph/defaults';
import { readRuleTable } from '../graph/rules';
import { remapTrafficSource } from '../graph/trafficRuleSource';
import { readDnsFilter } from '../graph/dns';
import { remapDnsSource } from '../graph/dnsRuleSource';
import { readPolicySources, type PolicyReference } from '../graph/policySources';
import { readProxyChain } from '../graph/proxyChains';
import { remapPreparedSubscriptions } from '../graph/composites';
import { clearNodePosition } from '../graph/placement';
import { jsonArray, jsonRecord, jsonEqual, checkJson, parseJson } from '../graph/xrayJson';
import { parseStash, serializeStash, type Stash, type Profile } from '../profiles/import';
import { syncGraphEdits, syncStashEdits } from '../profiles/workspace';
import { validatePreferences, type Preferences } from './preferences';
import type { GraphDocument, GraphState, RuleNodeData } from '../graph/types';

export type BackupScope = 'full' | 'graph' | 'stash' | 'filters';
export const isBackupFilter = (kind: string) =>
  kind === 'routing-filter' || kind === 'dns-routing-filter';
export interface BackupContent {
  createdAt: string;
  appVersion: string;
  graph?: GraphDocument;
  stash?: unknown;
  linkedStash?: { document: unknown; partialGroups: string[] };
  preferences?: Preferences;
  filters?: RuleNodeData[];
}
export interface RestoreSelection {
  graph: boolean;
  stash: boolean;
  preferences: boolean;
  filters: boolean;
  stashMode: 'merge' | 'replace';
  targetId?: string;
  filterIndex?: number;
}
export interface RestoredWorkspace {
  resetViewport?: boolean;
  graph?: GraphState;
  stash?: Stash;
  preferences?: Preferences;
}
const savedStash = (stash: Stash): unknown => parseJson(serializeStash(stash));
const loadStash = (value: unknown) => parseStash(JSON.stringify(value));

/** Include referenced entries and complete dynamic subscription pools, not unrelated groups. */
export function graphDependencies(
  graph: GraphState,
  stash: Stash,
  wholeGroups = new Set<string>(),
): Stash {
  const groups = new Map(stash.groups.map((g) => [g.id, g]));
  const selected = new Map<string, Set<string>>();
  const visited = new Set<Profile>();
  const entry = (groupId: string, entryId?: string) => {
    const group = groups.get(groupId);
    if (!group) return;
    if (entryId === undefined) wholeGroups.add(groupId);
    const ids = selected.get(groupId) ?? new Set<string>();
    selected.set(groupId, ids);
    for (const row of group.entries) {
      if ((entryId !== undefined && row.id !== entryId) || ids.has(row.id)) continue;
      ids.add(row.id);
      if (row.profile) visit(row.profile);
      if (row.draft) visit({ kind: row.draft.kind, settings: row.draft.settings });
    }
  };
  const reference = (ref: PolicyReference, depth: number) => {
    if (ref.type !== 'profile') return;
    if (ref.source) entry(ref.source.groupId, ref.source.entryId);
    visit(ref.profile, depth);
  };
  const visit = (profile: Profile, depth = 0) => {
    if (visited.has(profile) || depth >= 16) return;
    visited.add(profile);
    const data = { ...profile, label: '', description: '' };
    if (profile.kind === 'policy-group') {
      const sources = readPolicySources(data);
      for (const ref of sources.manual) reference(ref, depth + 1);
      if (sources.fallback) reference(sources.fallback, depth + 1);
      for (const sub of sources.subscriptions) entry(sub.groupId);
    } else if (profile.kind === 'proxy-chain') {
      for (const step of readProxyChain(data).steps) reference(step.outbound, depth + 1);
    }
  };
  for (const node of graph.nodes) {
    if (node.data.stashLink) entry(node.data.stashLink.groupId, node.data.stashLink.entryId);
    visit(node.data as Profile);
  }
  return {
    ...stash,
    groups: stash.groups
      .filter((g) => selected.has(g.id))
      .map((g) => ({ ...g, entries: g.entries.filter((e) => selected.get(g.id)!.has(e.id)) })),
  };
}

function filterData(value: unknown): RuleNodeData {
  if (!jsonRecord(value) || !isBackupFilter(String(value.kind)))
    throw new Error('A filter backup can contain only Traffic and DNS routing filters.');
  const graph = parseGraph(
    JSON.stringify({
      format: 'wayrill.graph',
      version: 2,
      name: 'Filter',
      defaults: factoryDefaults(),
      nodes: [{ id: 'filter', position: { x: 0, y: 0 }, data: value }],
      edges: [],
    }),
  );
  const data = graph.nodes[0].data;
  if (data.kind === 'routing-filter') readRuleTable(data.settings);
  else readDnsFilter(data.settings);
  return data;
}
export function validateContent(value: unknown): BackupContent {
  if (
    !jsonRecord(value) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.appVersion !== 'string' ||
    value.appVersion.length > 64
  )
    throw new Error('Invalid backup metadata.');
  checkJson(value);
  const content: BackupContent = { createdAt: value.createdAt, appVersion: value.appVersion };
  if (value.graph !== undefined)
    content.graph = toDocument(parseGraph(JSON.stringify(value.graph)));
  if (value.stash !== undefined) content.stash = savedStash(loadStash(value.stash));
  if (value.linkedStash !== undefined) {
    if (!content.graph) throw new Error('Linked configurations require a graph.');
    if (!jsonRecord(value.linkedStash) || !jsonArray(value.linkedStash.partialGroups))
      throw new Error('Invalid graph dependencies.');
    const dependency = loadStash(value.linkedStash.document);
    const partialGroups = value.linkedStash.partialGroups;
    if (
      partialGroups.length > 500 ||
      partialGroups.some(
        (id) => typeof id !== 'string' || !dependency.groups.some((g) => g.id === id),
      )
    )
      throw new Error('Invalid partial dependency groups.');
    content.linkedStash = {
      document: savedStash(dependency),
      partialGroups: partialGroups as string[],
    };
  }
  if (value.preferences !== undefined) content.preferences = validatePreferences(value.preferences);
  if (value.filters !== undefined) {
    if (
      !jsonArray(value.filters) ||
      !value.filters.length ||
      value.filters.length > 500 ||
      content.graph
    )
      throw new Error('Invalid filter backup.');
    content.filters = value.filters.map(filterData);
  }
  if (!content.graph && !content.stash && !content.preferences && !content.filters)
    throw new Error('The backup has no restorable configuration.');
  return content;
}
export function createContent(
  scope: BackupScope,
  graph: GraphState,
  stash: Stash,
  preferences: Preferences,
  filterIds: string[],
): BackupContent {
  const content: BackupContent = { createdAt: new Date().toISOString(), appVersion };
  if (scope === 'full' || scope === 'graph') content.graph = toDocument(graph);
  if (scope === 'full' || scope === 'stash') content.stash = savedStash(stash);
  if (scope === 'graph') content.linkedStash = dependencyBundle(graph, stash);
  if (scope === 'full') content.preferences = preferences;
  if (scope === 'filters')
    content.filters = toDocument(graph)
      .nodes.filter((n) => filterIds.includes(n.id) && isBackupFilter(n.data.kind))
      .map((n) => n.data);
  return validateContent(content);
}

/** Conflicting identities are forked as whole groups, keeping references unambiguous. */
function dependencyBundle(graph: GraphState, stash: Stash) {
  const whole = new Set<string>();
  const dependencies = graphDependencies(graph, stash, whole);
  return {
    document: savedStash(dependencies),
    partialGroups: dependencies.groups.filter((g) => !whole.has(g.id)).map((g) => g.id),
  };
}
function mergeStash(current: Stash, incoming: Stash, partialGroups: ReadonlySet<string>) {
  const mapping = new Map<string, string>();
  const byId = new Map(current.groups.map((g) => [g.id, g]));
  const compatible = (group: Stash['groups'][number]) => {
    const previous = byId.get(group.id);
    if (!previous || jsonEqual(previous, group)) return true;
    if (
      !partialGroups.has(group.id) ||
      !jsonEqual({ ...previous, entries: [] }, { ...group, entries: [] })
    )
      return false;
    const entries = new Map(previous.entries.map((e) => [e.id, e]));
    return group.entries.every((e) => jsonEqual(entries.get(e.id), e));
  };
  const conflict = incoming.groups.some((g) => !compatible(g));
  for (const group of incoming.groups) {
    const previous = byId.get(group.id);
    // Fork colliding groups together: an unchanged parent's references must
    // follow a restored child rather than the current child's definition.
    mapping.set(group.id, previous && conflict ? crypto.randomUUID() : group.id);
  }
  const added = incoming.groups
    .filter((g) => mapping.get(g.id) !== g.id || !byId.has(g.id))
    .map((g) => ({
      ...g,
      id: mapping.get(g.id)!,
      name: mapping.get(g.id) === g.id ? g.name : `${g.name.slice(0, 116)} (restored)`,
      entries: g.entries.map((e) => ({
        ...e,
        ...(e.profile ? { profile: remapPreparedSubscriptions(e.profile, mapping) } : {}),
        ...(e.draft
          ? {
              draft: {
                ...e.draft,
                settings: remapPreparedSubscriptions(
                  { kind: e.draft.kind, settings: e.draft.settings },
                  mapping,
                ).settings,
              },
            }
          : {}),
      })),
    }));
  return {
    stash: added.length ? { ...current, groups: [...current.groups, ...added] } : current,
    mapping,
  };
}
function mapGraph(graph: GraphState, mapping: Map<string, string>): GraphState {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        settings: remapPreparedSubscriptions(n.data as Profile, mapping).settings,
        ...(n.data.stashLink
          ? {
              stashLink: {
                ...n.data.stashLink,
                groupId: mapping.get(n.data.stashLink.groupId) ?? n.data.stashLink.groupId,
              },
            }
          : {}),
      },
    })),
  };
}

function restoreFilter(graph: GraphState, data: RuleNodeData, targetId?: string): GraphState {
  if (!targetId) {
    if (graph.nodes.length >= 500) throw new Error('The graph supports at most 500 nodes.');
    if (graph.xray)
      throw new Error('Restore into the existing routing filter in an imported Xray graph.');
    return {
      ...graph,
      nodes: [
        ...graph.nodes.map((n) => ({ ...n, selected: false })),
        {
          id: crypto.randomUUID(),
          type: 'rule',
          selected: true,
          position: clearNodePosition(graph.nodes, { x: 100, y: 100 }),
          data,
        },
      ],
    };
  }
  const target = graph.nodes.find((n) => n.id === targetId);
  if (!target || target.data.kind !== data.kind)
    throw new Error('Choose an existing filter of the same type.');
  const outputs = (settings: RuleNodeData['settings']) =>
    data.kind === 'routing-filter'
      ? readRuleTable(settings).outputs
      : readDnsFilter(settings).outputs;
  const old = outputs(target.data.settings),
    used = new Set<string>(),
    mapping = new Map<string, string>();
  const next = outputs(data.settings).map((output, i) => {
    const match = old.find(
      (o) =>
        !used.has(o.id) &&
        (('fallback' in output && output.fallback && 'fallback' in o && o.fallback) ||
          o.name === output.name),
    );
    let id = match?.id ?? output.id;
    if (used.has(id) || (!match && old.some((o) => o.id === id)))
      id = `restored-${i}-${crypto.randomUUID()}`;
    used.add(id);
    mapping.set(output.id, id);
    return { ...output, id };
  });
  const settings: RuleNodeData['settings'] = { ...data.settings, outputs: JSON.stringify(next) };
  const rules = (
    data.kind === 'routing-filter'
      ? readRuleTable(data.settings).rules
      : readDnsFilter(data.settings).rules
  ).map((r) => ({ ...r, output: mapping.get(r.output) ?? r.output }));
  settings.rules = JSON.stringify(rules);
  if (data.kind === 'routing-filter') {
    const table = remapTrafficSource(readRuleTable(data.settings), mapping);
    settings.rules = JSON.stringify(table.rules);
    settings.ruleSource = table.source ? JSON.stringify(table.source) : '';
    settings.defaultOutput = mapping.get(table.defaultOutput)!;
    if (table.tunAmbiguity)
      settings.tunAmbiguity = JSON.stringify({
        ...table.tunAmbiguity,
        output: mapping.get(table.tunAmbiguity.output) ?? '',
      });
  } else {
    const filter = remapDnsSource(readDnsFilter(data.settings), mapping);
    settings.rules = JSON.stringify(filter.rules);
    settings.ruleSource = filter.source ? JSON.stringify(filter.source) : '';
  }
  const restored = updateGraphNode(graph, targetId, { ...data, settings });
  return { ...restored, nodes: restored.nodes.map((n) => ({ ...n, selected: n.id === targetId })) };
}

export function prepareRestore(
  content: BackupContent,
  selection: RestoreSelection,
  currentGraph: GraphState,
  currentStash: Stash,
): RestoredWorkspace {
  let graph = currentGraph,
    stash = currentStash;
  const restoringGraph = selection.graph && !!content.graph;
  const restoringStash = selection.stash && content.stash !== undefined;
  const dependency =
    restoringGraph && !restoringStash
      ? (content.linkedStash ??
        (content.stash ? dependencyBundle(content.graph!, loadStash(content.stash)) : undefined))
      : undefined;
  const library = restoringStash
    ? loadStash(content.stash)
    : dependency
      ? loadStash(dependency.document)
      : undefined;
  if (restoringGraph) graph = parseGraph(JSON.stringify(content.graph));
  if (library) {
    if (restoringStash && selection.stashMode === 'replace') stash = library;
    else {
      const merged = mergeStash(
        stash,
        library,
        new Set(restoringStash ? [] : dependency?.partialGroups),
      );
      stash = merged.stash;
      if (restoringGraph) graph = mapGraph(graph, merged.mapping);
    }
  }
  if (selection.filters && content.filters) {
    const previousIds = new Set(graph.nodes.map((n) => n.id));
    const filters =
      selection.filterIndex === undefined
        ? content.filters
        : [content.filters[selection.filterIndex]];
    if (selection.targetId && filters.length !== 1)
      throw new Error('Choose one filter to restore into this node.');
    for (const filter of filters) {
      if (!filter) throw new Error('Choose a filter from the backup.');
      graph = restoreFilter(graph, filter, selection.targetId);
    }
    if (!selection.targetId)
      graph = {
        ...graph,
        nodes: graph.nodes.map((n) => ({ ...n, selected: !previousIds.has(n.id) })),
      };
  }
  if (!restoringGraph && stash !== currentStash) graph = syncStashEdits(graph, currentStash, stash);
  if (restoringGraph || stash !== currentStash) {
    const adopted = syncGraphEdits(graph, graph, stash, true);
    graph = adopted.graph;
    stash = adopted.stash;
  }
  // Use the normal strict boundaries before making any workspace change.
  const graphChanged = graph !== currentGraph,
    stashChanged = stash !== currentStash;
  if (stashChanged) stash = loadStash(savedStash(stash));
  if (graphChanged) {
    const selected = new Set(graph.nodes.filter((n) => n.selected).map((n) => n.id));
    graph = parseGraph(JSON.stringify(toDocument(graph)));
    graph.nodes = graph.nodes.map((n) => ({ ...n, selected: selected.has(n.id) }));
  }
  return {
    ...(restoringGraph ? { resetViewport: true } : {}),
    ...(graphChanged ? { graph } : {}),
    ...(stashChanged ? { stash } : {}),
    ...(selection.preferences && content.preferences ? { preferences: content.preferences } : {}),
  };
}

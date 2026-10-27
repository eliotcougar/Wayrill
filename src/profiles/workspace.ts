import { isOutboundKind } from '../graph/outbounds';
import { preparedEntry, profileNode, samePreparedDefinition } from '../graph/composites';
import { jsonEqual } from '../graph/xrayJson';
import { applyStashedEntry } from './graph';
import { DEFAULT_GROUP_ID, findStashEntry, putStashEntry } from './stashModel';
import type { Stash, StashEntry, ProfileKind } from './import';
import type { GraphState, RuleNode, RuleNodeData, StashLink } from '../graph/types';

export function stashEditorNode(entry: StashEntry, graph: GraphState, id: string): RuleNode {
  if (entry.draft)
    return {
      id,
      type: 'rule',
      position: { x: 0, y: 0 },
      data: {
        ...structuredClone(entry.draft),
        label: entry.name,
        description: entry.draft.description ?? '',
      },
    };
  if (!entry.profile) throw new Error('This entry has no editable outbound settings.');
  return profileNode(entry.profile, entry.name, graph, id);
}
export function snapshotGraphEntry(
  graph: GraphState,
  node: RuleNode,
  id: string = crypto.randomUUID(),
  previous?: StashEntry,
): StashEntry {
  let profile: StashEntry['profile'] = null,
    problem = '';
  try {
    profile = preparedEntry(graph, node.id, id).profile;
  } catch (e) {
    problem = e instanceof Error ? e.message : 'Incomplete outbound settings.';
  }
  // Prepared definitions are portable: graph references become contained snapshots.
  const settings =
    profile && ['policy-group', 'proxy-chain'].includes(node.data.kind)
      ? profile.settings
      : node.data.settings;
  const draft = {
    kind: node.data.kind as ProfileKind,
    description: node.data.description,
    settings: structuredClone(settings),
    overrides: [...(node.data.overrides ?? [])],
    ...(node.data.native ? { native: structuredClone(node.data.native) } : {}),
  };
  return {
    ...previous,
    id,
    name: node.data.label,
    protocol: previous?.protocol ?? (profile?.kind ?? node.data.kind).replace(/-outbound$/, ''),
    address: String(node.data.settings.address ?? ''),
    raw: '',
    profile,
    problem,
    draft,
  };
}
const content = (data: RuleNodeData) => ({
  kind: data.kind,
  label: data.label,
  description: data.description,
  settings: data.settings,
  overrides: data.overrides ?? [],
  native: data.native,
});
const linkKey = (link: StashLink) => JSON.stringify([link.groupId, link.entryId]);

/** Commit edited configurations before publishing the graph; never capture layout/selection edits. */
export function syncGraphEdits(
  before: GraphState,
  after: GraphState,
  library: Stash,
  adopt = false,
) {
  let graph = after,
    stash = library;
  const oldNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const edits = new Map<string, { entry: StashEntry; link: StashLink; editedId: string }>();
  for (const node of after.nodes) {
    if (!isOutboundKind(node.data.kind)) continue;
    const old = oldNodes.get(node.id);
    const changed = !old || !jsonEqual(content(old.data), content(node.data));
    const link = node.data.stashLink;
    const previous = link && findStashEntry(stash, link);
    if (previous && (!old?.data.stashLink || linkKey(old.data.stashLink) !== linkKey(link)))
      continue;
    if (previous && !changed) continue;
    if (!previous && !changed && !adopt) continue;
    const entry = snapshotGraphEntry(graph, node, previous?.id, previous);
    const nextLink = previous ? link : { groupId: DEFAULT_GROUP_ID, entryId: entry.id };
    stash = putStashEntry(stash, entry, previous ? nextLink : undefined);
    const saved = findStashEntry(stash, nextLink)!;
    graph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === node.id ? { ...n, data: { ...n.data, stashLink: nextLink } } : n,
      ),
    };
    edits.set(linkKey(nextLink), { entry: saved, link: nextLink, editedId: node.id });
  }
  for (const { entry, link, editedId } of edits.values()) {
    for (const node of graph.nodes) {
      if (
        node.id === editedId ||
        !node.data.stashLink ||
        linkKey(node.data.stashLink) !== linkKey(link)
      )
        continue;
      graph = applyStashedEntry(graph, entry, node, link);
    }
  }
  return { graph, stash };
}

// A derived library snapshot must not replace graph-local references with
// portable copies. Its dependencies are reconciled by refreshPolicyGraph.
function derivedPreparedChange(previous: StashEntry, next: StashEntry): boolean {
  if (
    !previous.profile ||
    !next.profile ||
    !['policy-group', 'proxy-chain'].includes(previous.profile.kind) ||
    previous.name !== next.name ||
    previous.draft?.description !== next.draft?.description
  )
    return false;
  try {
    return samePreparedDefinition(previous.profile, next.profile);
  } catch {
    return false;
  }
}
/** Library-origin changes update only linked nodes; missing entries detach, retaining the last draft. */
export function syncStashEdits(
  graph: GraphState,
  before: Stash | undefined,
  after: Stash,
  scope?: ReadonlySet<string>,
): GraphState {
  let next = graph;
  for (const node of graph.nodes) {
    const link = node.data.stashLink;
    if (!link || !isOutboundKind(node.data.kind) || (scope && !scope.has(link.groupId))) continue;
    const entry = findStashEntry(after, link);
    if (!entry) {
      const data = { ...node.data };
      delete data.stashLink;
      next = { ...next, nodes: next.nodes.map((n) => (n.id === node.id ? { ...n, data } : n)) };
      continue;
    }
    const previous = before && findStashEntry(before, link);
    if (
      entry === previous ||
      (previous && derivedPreparedChange(previous, entry)) ||
      (previous &&
        jsonEqual(
          [entry.name, entry.profile, entry.draft],
          [previous.name, previous.profile, previous.draft],
        ))
    )
      continue;
    next = applyStashedEntry(next, entry, node, link);
  }
  return next;
}

function mergeEditedFields<T extends object>(before: T, draft: T, latest: T): T {
  const merged = { ...latest };
  for (const key of new Set([...Object.keys(before), ...Object.keys(draft)]) as Set<keyof T>) {
    if (jsonEqual(before[key], draft[key])) continue;
    if (Object.hasOwn(draft, key)) merged[key] = draft[key];
    else delete merged[key];
  }
  return merged;
}

/** Reapply only edited fields after a library refresh; keep layout and untouched settings. */
export function rebaseGraphDraft(
  before: GraphState,
  draft: GraphState,
  latest: GraphState,
): GraphState {
  const originals = new Map(before.nodes.map((node) => [node.id, node]));
  const refreshed = new Map(latest.nodes.map((node) => [node.id, node]));
  return {
    ...draft,
    nodes: draft.nodes.map((node) => {
      const old = originals.get(node.id),
        fresh = refreshed.get(node.id);
      if (!old || !fresh) return node;
      return {
        ...node,
        data: {
          ...mergeEditedFields(old.data, node.data, fresh.data),
          settings: mergeEditedFields(old.data.settings, node.data.settings, fresh.data.settings),
        },
      };
    }),
  };
}

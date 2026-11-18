import { remapPreparedSubscriptions } from '../graph/composites';
import { dnsFilterSettings, readDnsFilter } from '../graph/dns';
import { parseGraph, toDocument } from '../graph/model';
import { refreshPolicyGraph } from '../graph/policySources';
import { readRuleTable, tableSettings } from '../graph/rules';
import { generatedTag } from '../graph/tags';
import type { GraphState, PoolGraphLink } from '../graph/types';
import { parseStash, serializeStash, type Stash } from '../profiles/import';
import { graphDependencies } from '../profiles/workspaceDependencies';
import { syncStashEdits } from '../profiles/workspace';
import { composePoolLayers, type PoolLayer } from './layers';
import type { PoolBundle } from './model';

export const graphLinks = (bundle: PoolBundle | undefined): PoolGraphLink[] =>
  bundle && bundle.version !== 1 ? (bundle.linkedLayers ?? []) : [];

const linkedGroupId = (layer: PoolLayer, group: string) =>
  generatedTag('pool-layer', JSON.stringify([layer.id, group]));

function linkedStash(layer: PoolLayer) {
  if (layer.data.kind !== 'stash') throw new Error('Select a Stash layer.');
  const stash = parseStash(layer.data.stash);
  const ids = new Map(stash.groups.map(({ id }) => [id, linkedGroupId(layer, id)]));
  return {
    ...stash,
    groups: stash.groups.map((group) => ({
      ...group,
      id: ids.get(group.id)!,
      name: (stash.groups.length === 1 ? layer.name : `${layer.name} · ${group.name}`).slice(
        0,
        128,
      ),
      entries: group.entries.map((entry) => ({
        ...entry,
        profile: entry.profile && remapPreparedSubscriptions(entry.profile, ids),
        draft: entry.draft && {
          ...entry.draft,
          settings: remapPreparedSubscriptions(entry.draft, ids).settings,
        },
      })),
    })),
  };
}

function selectedLayers(layers: readonly PoolLayer[], links: readonly PoolGraphLink[]) {
  const ids = new Set(links.map(({ id }) => id));
  const selected = layers.filter((layer) => ids.delete(layer.id));
  if (ids.size) throw new Error('A linked layer is unavailable. Review the graph’s linked layers.');
  return selected;
}

export function withoutLinkedStashes(
  stash: Stash,
  layers: readonly PoolLayer[],
  links: readonly PoolGraphLink[],
) {
  const supplied = new Set(
    layers
      .filter((layer) => links.some(({ id }) => id === layer.id))
      .flatMap((layer) =>
        layer.data.kind === 'stash'
          ? parseStash(layer.data.stash).groups.map(({ id }) => linkedGroupId(layer, id))
          : [],
      ),
  );
  return { ...stash, groups: stash.groups.filter(({ id }) => !supplied.has(id)) };
}

type Output = { id: string; name: string; fallback?: boolean };

// Keep wired graph ports. A new source port becomes available for wiring in
// the editor, while existing ports can match by ID or by unambiguous name.
function withSourcePorts<T extends Output>(current: T[], source: T[]): T[] {
  const outputs = [...current];
  const used = new Set<string>();
  for (const port of source) {
    const candidates = outputs.filter((output) =>
      port.fallback
        ? output.fallback
        : output.name.trim().toLowerCase() === port.name.trim().toLowerCase(),
    );
    const existing = port.fallback
      ? candidates[0]
      : (outputs.find(({ id }) => id === port.id) ??
        (candidates.length === 1 ? candidates[0] : undefined));
    if (existing && !!existing.fallback === !!port.fallback && !used.has(existing.id)) {
      used.add(existing.id);
      continue;
    }
    if (outputs.some(({ id }) => id === port.id))
      throw new Error(
        `The source and graph both use output ID “${port.id}”. Match the graph outputs to the source layer.`,
      );
    outputs.push(port);
    used.add(port.id);
  }
  return outputs;
}

export function addLinkedFilterPorts(
  graph: GraphState,
  layers: readonly PoolLayer[],
  links: readonly PoolGraphLink[],
): GraphState {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const byTarget = new Map(
    links.filter(({ target }) => target).map(({ id, target }) => [target, id]),
  );
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const source = byId.get(byTarget.get(node.id) ?? '')?.data;
      const settings = node.data.settings;
      if (source?.kind === 'traffic' && node.data.kind === 'routing-filter') {
        const table = readRuleTable(settings);
        return {
          ...node,
          data: {
            ...node.data,
            settings: {
              ...settings,
              ...tableSettings({
                ...table,
                outputs: withSourcePorts(table.outputs, source.filter.table.outputs),
              }),
            },
          },
        };
      }
      if (source?.kind === 'dns' && node.data.kind === 'dns-routing-filter') {
        const filter = readDnsFilter(settings);
        return {
          ...node,
          data: {
            ...node.data,
            settings: {
              ...settings,
              ...dnsFilterSettings({
                ...filter,
                outputs: withSourcePorts(filter.outputs, source.filter.outputs),
              }),
            },
          },
        };
      }
      return node;
    }),
  };
}

export function resolveGraphLinks(bundle: PoolBundle, layers: readonly PoolLayer[]): PoolBundle {
  if (bundle.version === 1 || !bundle.linkedLayers) return bundle;
  const { linkedLayers: links, ...base } = bundle;
  const selected = selectedLayers(layers, links);
  const byId = new Map(selected.map((layer) => [layer.id, layer]));
  for (const link of links) {
    const layer = byId.get(link.id)!;
    if ((layer.data.kind === 'stash') === !!link.target)
      throw new Error(`Review where “${layer.name}” is linked.`);
  }
  const filters = links.filter(({ target }) => target);
  const resolved = composePoolLayers(base, selected, filters, true);
  const shared = selected.flatMap((layer) =>
    layer.data.kind === 'stash' ? linkedStash(layer).groups : [],
  );
  const localStash = parseStash(resolved.stash);
  const sharedIds = new Set(shared.map(({ id }) => id));
  const stash = {
    ...localStash,
    groups: [...localStash.groups.filter(({ id }) => !sharedIds.has(id)), ...shared],
  };
  const graph = parseGraph(resolved.graph);
  const groupsById = new Map(stash.groups.map((group) => [group.id, group]));
  function checkReference(groupId: string, entryId?: string) {
    if (!groupId.startsWith('pool-layer-')) return;
    const group = groupsById.get(groupId);
    if (!group || (entryId !== undefined && !group.entries.some(({ id }) => id === entryId)))
      throw new Error(
        'This graph uses an unavailable linked Stash group or entry. Update its outbound, chain or policy group first.',
      );
  }
  for (const { data } of graph.nodes) {
    if (data.stashLink) checkReference(data.stashLink.groupId, data.stashLink.entryId);
  }
  const next = syncStashEdits(graph, undefined, stash, sharedIds);
  const refreshed = refreshPolicyGraph(next, stash);
  graphDependencies(refreshed, stash, new Set(), [], checkReference);
  return {
    ...resolved,
    graph: JSON.stringify(toDocument(refreshed)),
    stash: serializeStash(stash),
  };
}

export function linkedFilterKind(kind: string) {
  if (kind === 'routing-filter') return 'traffic';
  if (kind === 'dns-routing-filter') return 'dns';
}

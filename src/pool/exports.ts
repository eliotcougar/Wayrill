import { parseGraph, toDocument } from '../graph/model';
import { readRuleTable, tableSettings, type RuleTable } from '../graph/rules';
import { detachTrafficSource } from '../graph/trafficRuleSource';
import { applyStashedProfile } from '../profiles/graph';
import { parseEntry, parseStash, serializeStash } from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import { graphDependencies } from '../profiles/workspaceDependencies';
import { publishedTrafficTable, type PoolBundle } from './model';
import type { GraphState } from '../graph/types';
import { remapSourceOutputs } from '../graph/ruleSourceRemap';

export type PoolUser = {
  id: string;
  name: string;
  outbound: Record<string, unknown>;
};
export type FilterExport = { nodeId: string; table: RuleTable };

export function serverEntry(name: string, outbound: Record<string, unknown>) {
  const entry = parseEntry(JSON.stringify(outbound));
  if (
    !entry.profile ||
    ['direct-outbound', 'block-outbound', 'policy-group', 'proxy-chain'].includes(
      entry.profile.kind,
    )
  )
    throw new Error('The user connection must be an executable server outbound.');
  return { ...entry, name, raw: '' };
}

export function withPoolUser(bundle: PoolBundle, memberId: string, user: PoolUser): PoolBundle {
  const graph = parseGraph(bundle.graph);
  const main = graph.nodes.find((node) => node.id === graph.mainOutboundId);
  if (
    !main ||
    !main.data.kind.endsWith('-outbound') ||
    ['direct-outbound', 'block-outbound', 'dns-outbound', 'loopback-outbound'].includes(
      main.data.kind,
    )
  ) {
    throw new Error('Mark a dedicated server placeholder as Main in this Pool configuration.');
  }
  const stash = parseStash(bundle.stash);
  const entry = { ...serverEntry(user.name, user.outbound), id: memberId };
  const groupId = `aquifer-${memberId}`;
  const placeholder = {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === main.id ? { ...node, data: { ...node.data, description: '' } } : node,
    ),
  };
  const personalized = applyStashedProfile(placeholder, entry, main.position, main.id, {
    groupId,
    entryId: entry.id,
  });
  const template = main.data.stashLink;
  const isTemplate = (groupId: string, entryId: string) =>
    template?.groupId === groupId && template.entryId === entryId;
  if (template) {
    const profiles = stash.groups.flatMap((group) =>
      group.entries.flatMap((entry) =>
        isTemplate(group.id, entry.id)
          ? []
          : [entry.profile, entry.draft].filter((profile) => profile != null),
      ),
    );
    const reused = graphDependencies(personalized, stash, new Set(), profiles).groups.some(
      (group) => group.entries.some((entry) => isTemplate(group.id, entry.id)),
    );
    if (reused)
      throw new Error(
        'Another route or Stash entry uses the Main placeholder. Choose a dedicated server for the user connections.',
      );
  }
  const shared = stash.groups.flatMap((group) => {
    if (group.id !== template?.groupId) return [group];
    const entries = group.entries.filter((entry) => !isTemplate(group.id, entry.id));
    return entries.length ? [{ ...group, entries }] : [];
  });
  return {
    ...bundle,
    graph: JSON.stringify(toDocument(personalized)),
    stash: serializeStash({
      ...stash,
      groups: [
        ...shared,
        {
          ...defaultGroup(),
          id: groupId,
          name: 'Your server',
          entries: [entry],
        },
      ],
    }),
  };
}

export function poolOutputMap(
  from: { id: string; name: string; fallback?: boolean }[],
  to: { id: string; name: string; fallback?: boolean }[],
) {
  const names = new Map<string, typeof to>();
  const byId = new Map(to.map((port) => [port.id, port]));
  const name = (port: (typeof to)[number]) => port.name.trim().toLowerCase();
  for (const port of to) names.set(name(port), [...(names.get(name(port)) ?? []), port]);
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const port of from) {
    const candidates = names.get(name(port));
    const match = port.fallback
      ? to.find((target) => target.fallback)
      : (byId.get(port.id) ?? (candidates?.length === 1 ? candidates[0] : undefined));
    if (!match || !!match.fallback !== !!port.fallback || used.has(match.id)) return;
    map.set(port.id, match.id);
    used.add(match.id);
  }
  return map;
}

export function poolFilterTargets(
  bundle: PoolBundle,
  source: FilterExport,
  byName = false,
  graph?: GraphState,
) {
  const ids = new Set(source.table.outputs.map((output) => output.id));
  return (graph ?? parseGraph(bundle.graph)).nodes.filter((node) => {
    if (node.data.kind !== 'routing-filter') return false;
    const outputs = readRuleTable(node.data.settings).outputs;
    return byName
      ? !!poolOutputMap(source.table.outputs, outputs)
      : outputs.length === ids.size && outputs.every((output) => ids.has(output.id));
  });
}

export function withPoolFilter(
  bundle: PoolBundle,
  source: FilterExport,
  targetId: string,
  byName = false,
): PoolBundle {
  if (!poolFilterTargets(bundle, source, byName).some((node) => node.id === targetId))
    throw new Error(
      'Choose a Pool filter with the same output IDs. Export the graph if its wiring changed.',
    );
  const graph = parseGraph(bundle.graph);
  const target = graph.nodes.find((node) => node.id === targetId)!;
  const outputs = readRuleTable(target.data.settings).outputs;
  const map = poolOutputMap(source.table.outputs, outputs)!;
  const filter = remapSourceOutputs(publishedTrafficTable(detachTrafficSource(source.table)), map);
  target.data.settings = {
    ...target.data.settings,
    ...tableSettings({
      ...filter,
      outputs,
      defaultOutput: map.get(filter.defaultOutput)!,
      ...(filter.tunAmbiguity?.output && {
        tunAmbiguity: { ...filter.tunAmbiguity, output: map.get(filter.tunAmbiguity.output)! },
      }),
    }),
  };
  const document = JSON.stringify(toDocument(graph));
  parseGraph(document);
  return { ...bundle, graph: document };
}

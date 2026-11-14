import { dnsFilterSettings, readDnsFilter, type DnsFilter } from '../graph/dns';
import { detachDnsSource } from '../graph/dnsRuleSource';
import { parseGraph, toDocument } from '../graph/model';
import type { GraphState } from '../graph/types';
import { jsonRecord, parseJson } from '../graph/xrayJson';
import { parseStash, serializeStash } from '../profiles/import';
import { syncStashEdits } from '../profiles/workspace';
import { poolFilterTargets, poolOutputMap, withPoolFilter, type FilterExport } from './exports';
import { remapSourceOutputs } from '../graph/ruleSourceRemap';
import {
  parsePoolBundle,
  publishedTrafficTable,
  readPortableGraph,
  type PoolBundle,
} from './model';
import { readRuleTable, tableSettings } from '../graph/rules';
import { detachTrafficSource } from '../graph/trafficRuleSource';

export type LayerData =
  | { kind: 'stash'; stash: string }
  | { kind: 'traffic'; filter: FilterExport }
  | { kind: 'dns'; nodeId: string; filter: DnsFilter };
export type PoolLayer = { id: string; name: string; data: LayerData };
export type LayerAssignment = { id: string; target?: string };
export type PoolTransfer = { name: string } & ({ kind: 'graph'; bundle: PoolBundle } | LayerData);
export const layerNames = {
  graph: 'Graph',
  stash: 'Stash',
  traffic: 'Traffic filter',
  dns: 'DNS filter',
};

export function isBundle(value: unknown): value is PoolBundle {
  return (
    jsonRecord(value) &&
    value.format === 'wayrill.pool' &&
    (value.version === 1 || value.version === 2) &&
    typeof value.name === 'string' &&
    typeof value.graph === 'string' &&
    typeof value.stash === 'string' &&
    (value.version === 2 || jsonRecord(value.routes))
  );
}

export function isLayer(value: unknown): value is LayerData {
  if (!jsonRecord(value)) return false;
  if (value.kind === 'stash') return typeof value.stash === 'string';
  if (value.kind === 'traffic')
    return (
      jsonRecord(value.filter) &&
      typeof value.filter.nodeId === 'string' &&
      jsonRecord(value.filter.table) &&
      Array.isArray(value.filter.table.outputs) &&
      Array.isArray(value.filter.table.rules)
    );
  return (
    value.kind === 'dns' &&
    typeof value.nodeId === 'string' &&
    jsonRecord(value.filter) &&
    Array.isArray(value.filter.outputs) &&
    Array.isArray(value.filter.rules)
  );
}

export function parseTransfer(text: string): PoolTransfer {
  const value = parseJson(text);
  if (
    !jsonRecord(value) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 128
  )
    throw new Error('This Pool export has an invalid name.');
  const { name } = value;
  if (value.kind === 'graph' && isBundle(value.bundle)) {
    const bundle = parsePoolBundle(value.bundle);
    readPortableGraph(bundle.graph, bundle.version === 1 ? bundle.routes : undefined);
    parseStash(bundle.stash);
    return { name, kind: 'graph', bundle };
  }
  if (!isLayer(value)) throw new Error('This file is not a Wayrill Pool export.');
  if (value.kind === 'stash') {
    parseStash(value.stash);
    return { kind: 'stash', name, stash: value.stash };
  }
  if (value.kind === 'traffic')
    return {
      name,
      kind: 'traffic',
      filter: {
        nodeId: value.filter.nodeId,
        table: publishedTrafficTable(
          detachTrafficSource(readRuleTable(tableSettings(value.filter.table))),
        ),
      },
    };
  return {
    name,
    kind: 'dns',
    nodeId: value.nodeId,
    filter: detachDnsSource(readDnsFilter(dnsFilterSettings(value.filter))),
  };
}

export function layerTargets(
  bundle: PoolBundle,
  data: LayerData,
  byName = false,
  graph?: GraphState,
) {
  if (data.kind === 'stash') return [];
  if (data.kind === 'traffic') return poolFilterTargets(bundle, data.filter, byName, graph);
  const ids = new Set(data.filter.outputs.map((output) => output.id));
  return (graph ?? parseGraph(bundle.graph)).nodes.filter((node) => {
    if (node.data.kind !== 'dns-routing-filter') return false;
    const outputs = readDnsFilter(node.data.settings).outputs;
    return byName
      ? !!poolOutputMap(data.filter.outputs, outputs)
      : outputs.length === ids.size && outputs.every((output) => ids.has(output.id));
  });
}

export function defaultLayerTarget(bundle: PoolBundle, data: LayerData) {
  const targets = layerTargets(bundle, data);
  const source =
    data.kind === 'traffic' ? data.filter.nodeId : data.kind === 'dns' ? data.nodeId : '';
  return (
    targets.find((node) => node.id === source)?.id ?? (targets.length === 1 ? targets[0].id : '')
  );
}

export function composePoolLayers(
  bundle: PoolBundle,
  layers: readonly PoolLayer[],
  assignments: readonly LayerAssignment[],
  selectable = false,
) {
  if (!assignments.length) return bundle;
  let result = bundle;
  const filterTargets = new Set<string>(),
    stashGroups = new Set<string>();
  const base = parseStash(bundle.stash);
  const groups = new Map(base.groups.map((group) => [group.id, group]));
  for (const assignment of assignments) {
    const layer = layers.find((item) => item.id === assignment.id);
    if (!layer) throw new Error('An assigned layer is missing.');
    const { data } = layer;
    if (data.kind === 'stash') {
      for (const group of parseStash(data.stash).groups.filter((group) => group.entries.length)) {
        const previous = groups.get(group.id);
        if (selectable && stashGroups.has(group.id) && previous) {
          const entries = new Map(previous.entries.map((entry) => [entry.id, entry]));
          for (const entry of group.entries) {
            const old = entries.get(entry.id);
            if (old && JSON.stringify(old) !== JSON.stringify(entry))
              throw new Error(
                `Selected Stashes contain different versions of ${entry.name}. Choose one Stash.`,
              );
            entries.set(entry.id, entry);
          }
          groups.set(group.id, { ...previous, entries: [...entries.values()] });
          continue;
        }
        if (stashGroups.has(group.id))
          throw new Error(`Multiple Stash layers supply ${group.name}. Choose one.`);
        stashGroups.add(group.id);
        groups.set(group.id, group);
      }
      continue;
    }
    const target = assignment.target;
    if (!target || !layerTargets(result, data, selectable).some((node) => node.id === target))
      throw new Error(`Choose a compatible destination filter for ${layer.name}.`);
    if (filterTargets.has(target)) throw new Error('Choose one layer for each destination filter.');
    filterTargets.add(target);
    if (data.kind === 'traffic') result = withPoolFilter(result, data.filter, target, selectable);
    else {
      const graph = parseGraph(result.graph);
      const node = graph.nodes.find((node) => node.id === target)!;
      const outputs = readDnsFilter(node.data.settings).outputs;
      const map = poolOutputMap(data.filter.outputs, outputs)!;
      node.data.settings = {
        ...node.data.settings,
        ...dnsFilterSettings({ ...remapSourceOutputs(detachDnsSource(data.filter), map), outputs }),
      };
      const document = JSON.stringify(toDocument(graph));
      parseGraph(document);
      result = { ...result, graph: document };
    }
  }
  if (stashGroups.size) {
    const stash = { ...base, groups: [...groups.values()] };
    const graph = syncStashEdits(parseGraph(result.graph), base, stash, stashGroups);
    result = { ...result, graph: JSON.stringify(toDocument(graph)), stash: serializeStash(stash) };
  }
  return result;
}

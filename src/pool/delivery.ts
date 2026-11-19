import { applyStashedProfile } from '../profiles/graph';
import { parseStash } from '../profiles/import';
import { findStashEntry } from '../profiles/stashModel';
import { refreshStashComposites } from '../graph/policySources';
import { parseGraph, toDocument } from '../graph/model';
import { typedConnectionProblem } from '../graph/connectionTypes';
import type { NodeKind, StashLink } from '../graph/types';
import { jsonRecord, ownValue } from '../graph/xrayJson';
import {
  composePoolLayers,
  isLayer,
  layerTargets,
  type LayerAssignment,
  type PoolLayer,
} from './layers';
import { parsePoolBundle, type PoolBundle } from './model';
import { restorePoolDelivery } from './deliveryCompatibility';
import {
  combineDeviceLayers,
  isDeviceLayer,
  type DeviceLayerData,
  type DeviceSettings,
} from './deviceLayers';

export type PoolSelection = {
  graph: string;
  followDefault?: boolean;
  stashes?: string[];
  filters?: Record<string, string>;
  stashOverrides?: Record<string, boolean>;
  filterOverrides?: Record<string, string | null>;
  outbounds?: Record<string, StashLink>;
  deviceLayers?: string[];
};

export type PoolChoiceNames = {
  graph?: string;
  stashes?: Record<string, string>;
  filters?: Record<string, { target: string; layer: string }>;
  outbounds?: Record<string, { target: string; entry: string }>;
};

export type PoolDelivery = {
  format: 'wayrill.pool.catalog';
  version: 1 | 2;
  poolName?: string;
  defaultGraph: string;
  graphs: { id: string; bundle: PoolBundle; extensions?: unknown }[];
  layers: (PoolLayer & { extensions?: unknown })[];
  defaultLayers: { id: string; target?: string }[];
  extensions?: unknown;
};

export type PoolOptions = {
  defaultGraph: string;
  graphs: { id: string; name: string }[];
  stashes: { id: string; name: string }[];
  activeStashes: string[];
  defaultStashes: string[];
  deviceLayers?: { id: string; name: string; data: DeviceLayerData }[];
  filters: {
    id: string;
    name: string;
    choices: { id: string; name: string }[];
    active?: string;
    defaultLayer?: string;
  }[];
  outbounds: { id: string; name: string; accepts: NodeKind[] }[];
  entries: (StashLink & { name: string; kind: NodeKind })[];
  reviewRequired: boolean;
  unavailable: string[];
};

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function readDelivery(value: Record<string, unknown>): PoolDelivery {
  if (typeof value.version === 'number' && value.version > 2)
    throw new Error('This delivery requires a newer version of Wayrill.');
  if (
    (value.version !== 1 && value.version !== 2) ||
    (value.poolName !== undefined &&
      (typeof value.poolName !== 'string' ||
        !value.poolName.trim() ||
        value.poolName.length > 128)) ||
    !id(value.defaultGraph) ||
    !Array.isArray(value.graphs) ||
    !value.graphs.length ||
    !value.graphs.every((item) => jsonRecord(item) && id(item.id)) ||
    !Array.isArray(value.layers) ||
    !value.layers.every(
      (item) =>
        jsonRecord(item) && id(item.id) && typeof item.name === 'string' && isLayer(item.data),
    ) ||
    !Array.isArray(value.defaultLayers) ||
    !value.defaultLayers.every(
      (item) => jsonRecord(item) && id(item.id) && (item.target === undefined || id(item.target)),
    )
  )
    throw new Error('Invalid Wayrill Pool layer delivery.');
  return value as unknown as PoolDelivery;
}

export function resolvePoolDelivery(
  value: unknown,
  requested?: PoolSelection,
  inspect = false,
  previous?: PoolChoiceNames,
): {
  bundle: PoolBundle;
  selection?: PoolSelection;
  options?: PoolOptions;
  choiceNames?: PoolChoiceNames;
  deviceSettings?: DeviceSettings;
} {
  if (!jsonRecord(value) || value.format !== 'wayrill.pool.catalog') {
    if (requested && !inspect) throw new Error('The Pool has withdrawn the selected graph.');
    return { bundle: parsePoolBundle(value) };
  }
  const delivery = restorePoolDelivery(readDelivery(value));
  const unavailable: string[] = [];
  function missing(message: string) {
    if (!inspect) throw new Error(`${message} Open Edit configuration choices to review.`);
    unavailable.push(message);
  }
  const selected = delivery.graphs.find(({ id }) => id === requested?.graph);
  if (requested && !selected)
    missing(
      `The selected graph${previous?.graph ? ` “${previous.graph}”` : ''} is no longer available.`,
    );
  const choice = selected ?? delivery.graphs.find(({ id }) => id === delivery.defaultGraph);
  if (!choice) throw new Error('The Pool delivery has no default graph.');
  const base = parsePoolBundle(choice.bundle);
  const graph = parseGraph(base.graph);
  const layerById = new Map(delivery.layers.map((item) => [item.id, item]));
  const deviceLayers = delivery.layers.flatMap(({ id, name, data }) =>
    isDeviceLayer(data) ? [{ id, name, data }] : [],
  );
  const chosenDeviceLayers = deviceLayers.filter(({ id }) => requested?.deviceLayers?.includes(id));
  const defaults = delivery.defaultLayers.filter(({ id, target }) => {
    const layer = layerById.get(id);
    return (
      !!layer &&
      !isDeviceLayer(layer.data) &&
      (layer.data.kind === 'stash' || (choice.id === delivery.defaultGraph && !!target))
    );
  });
  const stashOverrides = selected && requested?.stashOverrides;
  const filterOverrides = selected && requested?.filterOverrides;
  const defaultStashes = defaults.filter(({ target }) => !target).map(({ id }) => id);
  const defaultFilters = Object.fromEntries(
    defaults.flatMap(({ id, target }) => (target ? [[target, id]] : [])),
  );
  const stashes = stashOverrides
    ? [...new Set([...defaultStashes, ...Object.keys(stashOverrides)])].filter(
        (id) => !Object.hasOwn(stashOverrides, id) || stashOverrides[id],
      )
    : selected && requested?.stashes;
  const filters = filterOverrides
    ? Object.fromEntries(
        Object.entries({ ...defaultFilters, ...filterOverrides }).filter(
          (item): item is [string, string] => item[1] !== null,
        ),
      )
    : selected && requested?.filters;
  const outbounds = (selected && requested?.outbounds) || {};
  const stashNames = new Map<string, string>();
  const filterNames = new Map<string, { target: string; layer: string }>();
  const outboundNames = new Map<string, { target: string; entry: string }>();
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node.data]));
  const byTarget = new Map<string, { id: string; name: string }[]>();
  for (const { id, data, name } of delivery.layers) {
    if (data.kind === 'stash') continue;
    for (const node of layerTargets(base, data, true, graph)) {
      const choices = byTarget.get(node.id) ?? [];
      choices.push({ id, name });
      byTarget.set(node.id, choices);
    }
  }
  const compatible = (target: string, layerId: string) =>
    byTarget.get(target)?.some(({ id }) => id === layerId);
  const assignments: LayerAssignment[] = [
    ...(stashes
      ? stashes.flatMap((id) => {
          const layer = layerById.get(id);
          if (layer?.data.kind !== 'stash') {
            // A withdrawn optional Stash cannot be delivered. Outbound assignments
            // below independently require every explicitly selected connection.
            if (stashOverrides) return [];
            const name = ownValue(previous?.stashes, id);
            missing(`A selected Stash${name ? ` “${name}”` : ''} is no longer available.`);
            return [];
          }
          stashNames.set(id, layer.name);
          return [{ id }];
        })
      : defaults.filter(({ target }) => !target)),
    ...(filters
      ? Object.entries(filters).flatMap(([target, id]) => {
          const saved = ownValue(previous?.filters, target);
          const name = layerById.get(id)?.name ?? saved?.layer;
          const targetName = nodeMap.get(target)?.label ?? saved?.target;
          if (!compatible(target, id)) {
            missing(
              `A selected filter${name ? ` “${name}”` : ''}${targetName ? ` for “${targetName}”` : ''} is no longer available or compatible.`,
            );
            return [];
          }
          filterNames.set(target, { target: targetName!, layer: name! });
          return [{ id, target }];
        })
      : defaults.filter(({ id, target }) => {
          if (!target) return false;
          if (compatible(target, id)) return true;
          missing(
            `The Pool’s default filter for “${nodeMap.get(target)?.label ?? target}” is unavailable or incompatible.`,
          );
          return false;
        })),
  ];
  const { bundle: effective, stashAliases } = composePoolLayers(base, delivery.layers, assignments);
  const placeholders = graph.nodes.filter((node) => node.data.poolOutbound);
  const stash =
    inspect || Object.keys(outbounds).length
      ? refreshStashComposites(parseStash(effective.stash))
      : undefined;
  const accepts = (nodeId: string, kind: NodeKind) =>
    graph.edges.every((edge) => {
      if (edge.target !== nodeId) return true;
      const source = nodeMap.get(edge.source);
      return (
        !source ||
        !typedConnectionProblem(source, edge.sourceHandle ?? '', { ...nodeMap.get(nodeId)!, kind })
      );
    });
  const resolved = new Map<string, StashLink>();
  const replacement = Object.entries(outbounds).reduce(
    (current, [nodeId, savedLink]) => {
      const node = placeholders.find((item) => item.id === nodeId);
      let link = savedLink;
      let entry = stash && findStashEntry(stash, link);
      if (stash && !entry) {
        const matching = (stashAliases.get(savedLink.groupId) ?? [])
          .map((groupId) => ({ groupId, entryId: savedLink.entryId }))
          .filter((candidate) => findStashEntry(stash, candidate));
        if (matching.length === 1) {
          [link] = matching;
          entry = findStashEntry(stash, link);
        }
      }
      if (!node || !entry?.profile || !accepts(nodeId, entry.profile.kind)) {
        const saved = ownValue(previous?.outbounds, nodeId);
        const name = entry?.name ?? saved?.entry;
        const target = nodeMap.get(nodeId)?.label ?? saved?.target;
        missing(
          `A selected outbound${name ? ` “${name}”` : ''}${target ? ` for “${target}”` : ''} is no longer available or compatible.`,
        );
        return current;
      }
      outboundNames.set(nodeId, { target: node.data.label, entry: entry.name });
      resolved.set(nodeId, link);
      return applyStashedProfile(current, entry, node.position, node.id, link);
    },
    effective === base ? graph : parseGraph(effective.graph),
  );
  const entries = inspect
    ? stash!.groups.flatMap((group) =>
        group.entries.flatMap((entry) =>
          entry.profile
            ? [
                {
                  groupId: group.id,
                  entryId: entry.id,
                  kind: entry.profile.kind,
                  name: `${entry.name} · ${group.name}`,
                },
              ]
            : [],
        ),
      )
    : [];
  const entryKinds = [...new Set(entries.map(({ kind }) => kind))];
  return {
    bundle: {
      ...effective,
      graph: JSON.stringify(toDocument(replacement)),
    } satisfies PoolBundle,
    selection: {
      graph: choice.id,
      ...(chosenDeviceLayers.length && { deviceLayers: chosenDeviceLayers.map(({ id }) => id) }),
      ...((!requested || requested.followDefault) && { followDefault: true }),
      ...(stashOverrides
        ? {
            stashOverrides: Object.fromEntries(
              Object.entries(stashOverrides).filter(
                ([id]) => layerById.get(id)?.data.kind === 'stash',
              ),
            ),
          }
        : stashes && { stashes: assignments.filter(({ target }) => !target).map(({ id }) => id) }),
      ...(filterOverrides
        ? {
            filterOverrides: Object.fromEntries(
              Object.entries(filterOverrides).filter(([target, id]) =>
                id === null ? nodeMap.has(target) : compatible(target, id),
              ),
            ),
          }
        : filters && {
            filters: Object.fromEntries(
              assignments.flatMap(({ id, target }) => (target ? [[target, id]] : [])),
            ),
          }),
      ...(requested?.outbounds && { outbounds: Object.fromEntries(resolved) }),
    } satisfies PoolSelection,
    ...(!inspect &&
      chosenDeviceLayers.length && {
        deviceSettings: combineDeviceLayers(chosenDeviceLayers.map(({ data }) => data)),
      }),
    choiceNames: {
      graph: base.name,
      stashes: Object.fromEntries(stashNames),
      filters: Object.fromEntries(filterNames),
      outbounds: Object.fromEntries(outboundNames),
    },
    ...(inspect && {
      options: {
        defaultGraph: delivery.defaultGraph,
        graphs: delivery.graphs.map(({ id, bundle }) => ({ id, name: bundle.name })),
        stashes: delivery.layers
          .filter((layer) => layer.data.kind === 'stash')
          .map(({ id, name }) => ({ id, name })),
        activeStashes: assignments.filter(({ target }) => !target).map(({ id }) => id),
        defaultStashes,
        deviceLayers,
        filters: graph.nodes.flatMap((node) => {
          if (node.data.kind !== 'routing-filter' && node.data.kind !== 'dns-routing-filter')
            return [];
          const choices = byTarget.get(node.id) ?? [];
          const active = assignments.find(({ target }) => target === node.id)?.id;
          return [
            {
              id: node.id,
              name: node.data.label,
              choices,
              active,
              defaultLayer: ownValue(defaultFilters, node.id),
            },
          ];
        }),
        outbounds: placeholders.map(({ id, data }) => ({
          id,
          name: data.label,
          accepts: entryKinds.filter((kind) => accepts(id, kind)),
        })),
        entries,
        reviewRequired: unavailable.length > 0,
        unavailable,
      } satisfies PoolOptions,
    }),
  };
}

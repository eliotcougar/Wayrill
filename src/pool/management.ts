import { accountRevision, type ObservedServer } from './accounts';
import { layerTargets, type LayerAssignment, type PoolTransfer } from './layers';
import type { PoolBundle } from './model';
import type { Member, Publisher } from './publisher';
import { memberGraphs, memberLayers } from './publisher';

export const usesLayer = (member: Member, id: string) =>
  memberGraphs(member).includes(id) || memberLayers(member).includes(id);

export const markDeliveryChanged = (member: Member): Member => ({
  ...member,
  deliveryChanged: true,
});

export function reserveDelivery(member: Member): Member {
  return {
    ...markDeliveryChanged(member),
    publication: (member.publication ?? 0) + 1,
    publishedAt: member.withdrawn ? undefined : member.publishedAt,
    withdrawn: false,
  };
}

export const mayHaveDelivery = (member: Member) =>
  !member.withdrawn && !!(member.publishedAt || member.publication);

export const deliveryPending = (member: Member, servers: readonly ObservedServer[]) =>
  !member.withdrawn &&
  (!member.publishedAt ||
    !!member.deliveryChanged ||
    accountRevision(servers, member.accounts) !== (member.publishedAccounts ?? ''));

export function retargetAssignments(
  pool: Publisher,
  graph: PoolBundle | undefined,
  assignments: readonly LayerAssignment[],
): LayerAssignment[] {
  return assignments.map((item) => {
    const layer = pool.layers?.find(({ id }) => id === item.id);
    if (!layer || layer.data.kind === 'stash') return item;
    if (!graph) return { id: item.id };
    if (layerTargets(graph, layer.data, true).some((node) => node.id === item.target)) return item;
    return { id: item.id };
  });
}

export function changeMemberGraph(
  pool: Publisher,
  member: Member,
  configurationId: string,
): Member {
  return {
    ...markDeliveryChanged(member),
    configurationId,
    assignments: retargetAssignments(
      pool,
      pool.configurations.find((item) => item.id === configurationId)?.bundle,
      member.assignments ?? [],
    ),
  };
}

export function getLayer(pool: Publisher, id: string): PoolTransfer | undefined {
  const graph = pool.configurations.find((item) => item.id === id);
  if (graph) return { kind: 'graph', name: graph.bundle.name, bundle: graph.bundle };
  const layer = pool.layers?.find((item) => item.id === id);
  if (layer) return { ...layer.data, name: layer.name };
}

function upsert<T extends { id: string }>(items: T[], item: T) {
  return items.some(({ id }) => id === item.id)
    ? items.map((value) => (value.id === item.id ? item : value))
    : [...items, item];
}

export function setLayerUsers(
  pool: Publisher,
  id: string,
  users: ReadonlyMap<string, string>,
): Publisher {
  const layer = getLayer(pool, id);
  if (!layer) throw new Error('The layer was removed.');
  return {
    ...pool,
    members: pool.members.map((member) => {
      const selected = users.has(member.id);
      if (layer.kind === 'graph') {
        const graphIds = memberGraphs(member);
        if (selected === graphIds.includes(id)) return member;
        const next = selected ? [...graphIds, id] : graphIds.filter((graph) => graph !== id);
        const base =
          member.configurationId === id || !member.configurationId
            ? (next[0] ?? '')
            : member.configurationId;
        return { ...changeMemberGraph(pool, member, base), graphIds: next };
      }
      const assignments = member.assignments ?? [];
      const old = assignments.find((item) => item.id === id);
      const target = users.get(member.id) || undefined;
      const layerIds = memberLayers(member);
      if (selected === layerIds.includes(id) && old?.target === target) return member;
      return {
        ...markDeliveryChanged(member),
        layerIds: selected
          ? [...new Set([...layerIds, id])]
          : layerIds.filter((item) => item !== id),
        assignments: selected
          ? target && old
            ? assignments.map((item) => (item.id === id ? { id, target } : item))
            : target
              ? [...assignments, { id, target }]
              : assignments.filter((item) => item.id !== id || layer.kind === 'stash')
          : assignments.filter((item) => item.id !== id),
      };
    }),
  };
}

export function putLayer(pool: Publisher, id: string, layer: PoolTransfer): Publisher {
  const { name, ...data } = layer;
  const next: Publisher =
    data.kind === 'graph'
      ? {
          ...pool,
          configurations: upsert(pool.configurations, { id, bundle: { ...data.bundle, name } }),
        }
      : {
          ...pool,
          layers: upsert(pool.layers ?? [], { id, name, data }),
        };
  return {
    ...next,
    members: pool.members.map((member) =>
      usesLayer(member, id) ? markDeliveryChanged(member) : member,
    ),
  };
}

export function removeLayer(pool: Publisher, id: string, graphReplacement = ''): Publisher {
  if (
    graphReplacement === id ||
    (graphReplacement && !pool.configurations.some((item) => item.id === graphReplacement))
  )
    throw new Error('Choose an existing replacement graph.');
  return {
    ...pool,
    configurations: pool.configurations.filter((item) => item.id !== id),
    layers: pool.layers?.filter((item) => item.id !== id),
    members: pool.members.map((member) => {
      if (memberGraphs(member).includes(id)) {
        const graphIds = memberGraphs(member).filter((item) => item !== id);
        if (member.configurationId !== id) return { ...markDeliveryChanged(member), graphIds };
        return {
          ...changeMemberGraph(pool, member, graphReplacement || graphIds[0] || ''),
          graphIds,
        };
      }
      if (!usesLayer(member, id)) return member;
      return {
        ...markDeliveryChanged(member),
        layerIds: member.layerIds?.filter((item) => item !== id),
        assignments: member.assignments?.filter((item) => item.id !== id),
      };
    }),
  };
}

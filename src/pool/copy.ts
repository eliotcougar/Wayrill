import { getLayer, markDeliveryChanged, putLayer } from './management';
import { graphLinks } from './graphLinks';
import { memberGraphs, memberLayers, type Member, type Publisher } from './publisher';

export function availableLayerName(name: string, existing: readonly string[]) {
  const base = name.trim().slice(0, 128);
  if (!existing.includes(base)) return base;
  for (let index = 2; ; index++) {
    const suffix = ' ' + index;
    const candidate = base.slice(0, 128 - suffix.length) + suffix;
    if (!existing.includes(candidate)) return candidate;
  }
}

/** Alternative Stashes keep identities so graph paths follow their changed credentials. */
export function copyLayer(pool: Publisher, id: string, name: string) {
  const source = getLayer(pool, id);
  if (!source) throw new Error('The source layer was removed.');
  const copy = crypto.randomUUID();
  return { pool: putLayer(pool, copy, structuredClone({ ...source, name })), id: copy };
}

export function withPrivateStashes(pool: Publisher, member: Member) {
  const stashes = new Set(memberLayers(member));
  for (const graph of pool.configurations.filter(({ id }) => memberGraphs(member).includes(id)))
    for (const { id } of graphLinks(graph.bundle)) stashes.add(id);
  const replacements = new Map<string, string>();
  const defaults = new Set((member.assignments ?? []).map(({ id }) => id));
  const primary = pool.configurations.find(({ id }) => id === member.configurationId);
  for (const link of primary ? graphLinks(primary.bundle) : []) defaults.add(link.id);
  let result = pool;
  for (const layer of pool.layers ?? []) {
    if (layer.data.kind !== 'stash' || !stashes.has(layer.id)) continue;
    const name = availableLayerName(
      member.name + ' · ' + layer.name,
      (result.layers ?? []).map((item) => item.name),
    );
    const copied = copyLayer(result, layer.id, name);
    result = copied.pool;
    replacements.set(layer.id, copied.id);
  }
  return {
    pool: result,
    member: {
      ...(replacements.size ? markDeliveryChanged(member) : member),
      layerIds: [...new Set([...memberLayers(member), ...replacements.keys()])].map(
        (id) => replacements.get(id) ?? id,
      ),
      assignments: [
        ...(member.assignments ?? []).map((assignment) => ({
          ...assignment,
          id: replacements.get(assignment.id) ?? assignment.id,
        })),
        ...[...replacements].flatMap(([oldId, id]) =>
          !defaults.has(oldId) || member.assignments?.some((assignment) => assignment.id === oldId)
            ? []
            : [{ id }],
        ),
      ],
    },
  };
}

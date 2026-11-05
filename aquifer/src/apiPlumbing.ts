import { jsonArray, jsonRecord } from './graph/xrayJson';
import { get, objectAt, setProperty } from './nativeProperties';
import type { RemoteView } from './remoteModel';

type Settings = Record<string, unknown>;
const inboundTags = (rule: Settings) => {
  const source = get(rule, 'inboundTag');
  return typeof source === 'string' ? [source] : jsonArray(source) ? source : [];
};
export type ApiListener = { index: number; value: Settings };
export function apiPlumbing(config: Settings) {
  const tag = get(objectAt(config, 'api'), 'tag');
  const rules = get(objectAt(config, 'routing'), 'rules');
  const inbounds = get(config, 'inbounds');
  const managedRules = new Set<number>(),
    inboundIndices = new Set<number>();
  const outbounds = get(config, 'outbounds');
  if (
    jsonArray(outbounds) &&
    outbounds.some((item) => jsonRecord(item) && get(item, 'tag') === tag)
  )
    return { tag, managedRules, inboundIndices, listeners: [] as ApiListener[] };
  if (typeof tag !== 'string' || !tag || !jsonArray(rules) || !jsonArray(inbounds))
    return { tag, managedRules, inboundIndices, listeners: [] as ApiListener[] };
  rules.forEach((rule, index) => {
    if (!jsonRecord(rule) || get(rule, 'outboundTag') !== tag) return;
    if (
      Object.keys(rule).some(
        (key) => !['type', 'inboundtag', 'outboundtag', 'ruletag'].includes(key.toLowerCase()),
      )
    )
      return;
    const tags = inboundTags(rule);
    if (!tags.length) return;
    const owned = tags.map((name) =>
      inbounds.findIndex(
        (entry) =>
          jsonRecord(entry) &&
          get(entry, 'tag') === name &&
          ['dokodemo-door', 'tunnel'].includes(String(get(entry, 'protocol')).toLowerCase()),
      ),
    );
    if (owned.some((index) => index < 0)) return;
    // A listener reused by another explicit routing rule remains a normal inbound.
    if (
      rules.some(
        (other, i) =>
          i !== index &&
          jsonRecord(other) &&
          get(other, 'outboundTag') !== tag &&
          inboundTags(other).some((name) => tags.includes(name)),
      )
    )
      return;
    managedRules.add(index);
    owned.forEach((index) => inboundIndices.add(index));
  });
  const listeners = [...inboundIndices].map((index) => ({
    index,
    value: inbounds[index] as Settings,
  }));
  return { tag, managedRules, inboundIndices, listeners };
}

export function editableRouting(config: Settings, routing: Settings) {
  const hidden = apiPlumbing(config).managedRules,
    rules = get(routing, 'rules');
  return hidden.size && jsonArray(rules)
    ? setProperty(
        routing,
        'rules',
        rules.filter((_, index) => !hidden.has(index)),
      )
    : routing;
}

export function restoreApiRules(config: Settings, routing: Settings) {
  const old = get(objectAt(config, 'routing'), 'rules'),
    edited = get(routing, 'rules') ?? [],
    hidden = apiPlumbing(config).managedRules;
  if (!hidden.size || !jsonArray(old) || !jsonArray(edited)) return routing;
  const merged: unknown[] = [];
  let cursor = 0;
  old.forEach((rule, index) => {
    if (hidden.has(index)) merged.push(rule);
    else if (cursor < edited.length) merged.push(edited[cursor++]);
  });
  return setProperty(routing, 'rules', [...merged, ...edited.slice(cursor)]);
}

/** API is concealed only in presentation; the executable graph remains complete. */
export function withoutApiPlumbing(view: RemoteView): RemoteView {
  const plumbing = apiPlumbing(view.normalized);
  const hidden = new Set([
    'remote-api',
    ...[...plumbing.inboundIndices].map((index) => `native-in-${index}`),
  ]);
  const removedPorts = new Map<string, Set<string>>();
  for (const edge of view.edges)
    if (hidden.has(edge.target) && edge.sourceHandle) {
      const ports = removedPorts.get(edge.source) ?? new Set<string>();
      ports.add(edge.sourceHandle);
      removedPorts.set(edge.source, ports);
    }
  return {
    ...view,
    nodes: view.nodes
      .filter((node) => !hidden.has(node.id))
      .map((node) => {
        const rules = node.data.rules?.filter((_, index) => !plumbing.managedRules.has(index));
        return {
          ...node,
          data: {
            ...node.data,
            outputs: node.data.outputs.filter((port) => !removedPorts.get(node.id)?.has(port.id)),
            ...(rules
              ? {
                  rules,
                  facts: node.data.facts.map(
                    ([key, value]) =>
                      [key, key === 'Rules' ? String(rules.length) : value] as [string, string],
                  ),
                }
              : {}),
          },
        };
      }),
    edges: view.edges.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target)),
  };
}

/** Merge dedicated listener drafts while preserving non-API inbounds and their order. */
export function updateApiListeners(
  config: Settings,
  listeners: ApiListener[],
  enabled: boolean,
): Settings {
  const plumbing = apiPlumbing(config),
    inbounds = get(config, 'inbounds'),
    routing = objectAt(config, 'routing');
  if (!plumbing.inboundIndices.size) return config;
  if (!jsonArray(inbounds)) return config;
  const edits = new Map(listeners.map((item) => [item.index, item.value]));
  const removedTags = new Set<unknown>();
  const nextInbounds = inbounds.flatMap((entry, index) => {
    if (!plumbing.inboundIndices.has(index)) return [entry];
    if (enabled && edits.has(index)) return [edits.get(index)!];
    if (jsonRecord(entry)) removedTags.add(get(entry, 'tag'));
    return [];
  });
  const rules = get(routing, 'rules');
  const nextRules = jsonArray(rules)
    ? rules.flatMap((rule, index) => {
        if (!plumbing.managedRules.has(index) || !jsonRecord(rule)) return [rule];
        const source = get(rule, 'inboundTag');
        const tags = typeof source === 'string' ? [source] : jsonArray(source) ? source : [];
        const next = tags.filter((tag) => !removedTags.has(tag));
        return next.length
          ? [setProperty(rule, 'inboundTag', typeof source === 'string' ? next[0] : next)]
          : [];
      })
    : rules;
  return setProperty(
    setProperty(config, 'inbounds', nextInbounds),
    'routing',
    setProperty(routing, 'rules', nextRules),
  );
}

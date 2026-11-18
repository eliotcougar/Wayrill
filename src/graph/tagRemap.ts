import { jsonRecord, jsonArray, jsonEqual, parseXrayJson } from './xrayJson';
import { nativeKey } from '@wayrill/core/nativeProperties';
import { remapOutboundReferences } from '@wayrill/core/outboundReferences';
import { readRuleTable, tableSettings, listEntries } from './rules';
import { editSourcedRule } from './trafficRuleSource';
import type { GraphState, RuleNodeData, SettingValue } from './types';
import type { TagNamespace } from './nodeTags';

export type TagMap = ReadonlyMap<string, string>;
const lines = (value: string, tags: TagMap) => {
  const entries = listEntries(value),
    mapped = entries.map((tag) => tags.get(tag) ?? tag);
  return mapped.some((tag, index) => tag !== entries[index]) ? mapped.join('\n') : value;
};

/** Mutate only the owned copy and only native reference fields. A header, domain,
 * credential or rule name equal to an old tag must keep its value. */
function ruleReferences(
  object: Record<string, unknown>,
  inbound: TagMap,
  outbound: TagMap,
  balancers: TagMap,
) {
  const replace = (object: Record<string, unknown>, key: string, tags: TagMap) => {
    const actual = nativeKey(object, key);
    const value = object[actual];
    if (typeof value === 'string') object[actual] = tags.get(value) ?? value;
    else if (jsonArray(value))
      object[actual] = value.map((tag) => (typeof tag === 'string' ? (tags.get(tag) ?? tag) : tag));
  };
  replace(object, 'inboundTag', inbound);
  replace(object, 'outboundTag', outbound);
  replace(object, 'balancerTag', balancers);
}

function remapTransportSettings(
  s: Record<string, SettingValue>,
  inbound: TagMap,
  outbound: TagMap,
): void {
  if (typeof s.dialerProxy === 'string')
    s.dialerProxy = outbound.get(s.dialerProxy) ?? s.dialerProxy;
  for (const key of ['json', 'streamSettings', 'sockoptExtra', 'xhttpExtra']) {
    if (typeof s[key] !== 'string' || !s[key]) continue;
    try {
      const object: unknown = parseXrayJson(s[key]);
      if (!jsonRecord(object)) continue;
      const before = JSON.stringify(object);
      const wrapper =
        key === 'streamSettings'
          ? { streamSettings: object }
          : key === 'sockoptExtra'
            ? { streamSettings: { sockopt: object } }
            : key === 'xhttpExtra'
              ? { streamSettings: { xhttpSettings: { extra: object } } }
              : object;
      remapOutboundReferences(wrapper, outbound, inbound);
      const after = JSON.stringify(object);
      if (after !== before) s[key] = after;
    } catch {
      /* Invalid drafts remain editable; duplication must not discard them. */
    }
  }
}

export function remapNodeTagReferences(
  data: RuleNodeData,
  inbound: TagMap,
  outbound: TagMap,
  balancers: TagMap,
): void {
  const s = data.settings;
  remapTransportSettings(s, inbound, outbound);
  if (data.native) {
    for (const object of [data.native.original, data.native.projection]) {
      if (data.kind === 'policy-group') {
        const key = nativeKey(object, 'fallbackTag'),
          tag = object[key];
        if (typeof tag === 'string') object[key] = outbound.get(tag) ?? tag;
      } else remapOutboundReferences(object, outbound, inbound);
    }
  }
  if (data.kind === 'routing-filter') {
    const table = readRuleTable(s);
    const original = tableSettings(table);
    table.rules = table.rules.map((rule) => {
      const value = rule.conditions.inboundTag;
      const updated = value && lines(value, inbound);
      const next =
        value && updated !== value
          ? editSourcedRule(rule, {
              conditions: { ...rule.conditions, inboundTag: updated },
            })
          : rule;
      if (next.native) {
        ruleReferences(next.native.original, inbound, outbound, balancers);
        ruleReferences(next.native.projection, inbound, outbound, balancers);
      }
      return next;
    });
    const updated = tableSettings(table);
    for (const [key, value] of Object.entries(updated)) if (value !== original[key]) s[key] = value;
  }
}

export function remapGraphTag(
  graph: GraphState,
  namespace: TagNamespace,
  previous: string,
  tag: string,
): GraphState {
  if (!previous || !tag || previous === tag) return graph;
  const empty: TagMap = new Map();
  const pair = new Map([[previous, tag]]);
  const inbound = namespace === 'inbound' ? pair : empty;
  const outbound = namespace === 'outbound' ? pair : empty;
  const balancer = namespace === 'balancer' ? pair : empty;
  const defaults = graph.defaults;
  const settings = defaults && { ...defaults.settings };
  if (settings && namespace !== 'balancer') remapTransportSettings(settings, inbound, outbound);
  return {
    ...graph,
    ...(defaults && settings && !jsonEqual(settings, defaults.settings)
      ? { defaults: { ...defaults, settings } }
      : {}),
    nodes: graph.nodes.map((node) => {
      const data = structuredClone(node.data);
      remapNodeTagReferences(data, inbound, outbound, balancer);
      return jsonEqual(data, node.data) ? node : { ...node, data };
    }),
    ...(graph.xray?.outboundPool && namespace !== 'balancer'
      ? {
          xray: {
            ...graph.xray,
            outboundPool: graph.xray.outboundPool.map((entry) => {
              const config = structuredClone(entry.config);
              remapOutboundReferences(config, outbound, inbound);
              return jsonEqual(config, entry.config) ? entry : { ...entry, config };
            }),
          },
        }
      : {}),
  };
}

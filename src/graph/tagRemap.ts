import { jsonRecord, jsonArray, parseXrayJson } from './xrayJson';
import { nativeKey } from '@wayrill/core/nativeProperties';
import { remapOutboundReferences } from '@wayrill/core/outboundReferences';
import { readRuleTable, tableSettings, listEntries } from './rules';
import { editSourcedRule } from './trafficRuleSource';
import type { RuleNodeData } from './types';

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

export function remapNodeTagReferences(
  data: RuleNodeData,
  inbound: TagMap,
  outbound: TagMap,
  balancers: TagMap,
): void {
  const s = data.settings;
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
    table.rules = table.rules.map((rule) => {
      const value = rule.conditions.inboundTag;
      const updated = value && lines(value, inbound);
      const next =
        value && updated !== value
          ? editSourcedRule(rule, { conditions: { ...rule.conditions, inboundTag: updated } })
          : rule;
      if (next.native) {
        ruleReferences(next.native.original, inbound, outbound, balancers);
        ruleReferences(next.native.projection, inbound, outbound, balancers);
      }
      return next;
    });
    Object.assign(s, tableSettings(table));
  }
}

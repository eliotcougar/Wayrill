import type { DnsRoute } from './dns';
import { dnsSourceFields, dnsSourceLists } from './dnsRuleSourceModel';
import { editSourceList, sourceEntries } from './ruleSourceEdits';

// Keep resource-reference edits independent of import/export and catalogue initialization.
export function editSourcedDnsRule(rule: DnsRoute, update: Partial<DnsRoute>): DnsRoute {
  const next = { ...rule, ...update };
  if (!rule.source) return next;
  const edits = structuredClone(rule.source.edits);
  for (const key of dnsSourceFields)
    if (Object.hasOwn(update, key) && rule[key] !== next[key])
      edits.fields = { ...edits.fields, [key]: next[key] };
  for (const key of dnsSourceLists)
    if (Object.hasOwn(update, key) && rule[key] !== next[key]) {
      const kind = key === 'domains' ? 'domain' : 'ip',
        change = editSourceList(
          edits.lists?.[key],
          sourceEntries(rule[key], kind),
          sourceEntries(next[key], kind),
          sourceEntries(rule.source.base[key], kind),
          kind,
        );
      const lists = { ...edits.lists };
      if (change) lists[key] = change;
      else delete lists[key];
      if (Object.keys(lists).length) edits.lists = lists;
      else delete edits.lists;
    }
  return { ...next, source: { ...rule.source, edits } };
}

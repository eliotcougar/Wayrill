import { readRuleTable } from './rules';
import type { PoolApplicationIdentity } from './applications';
import type { GraphState } from './types';

export function graphPoolApplications(graph: GraphState) {
  const identities = new Map<string, PoolApplicationIdentity>();
  for (const { data } of graph.nodes) {
    if (data.kind !== 'routing-filter') continue;
    for (const rule of readRuleTable(data.settings).rules) {
      if (!rule.enabled || rule.matchAll) continue;
      for (const app of rule.applications ?? []) {
        if (app.kind !== 'pool' || !app.enabled) continue;
        const prior = identities.get(app.identity.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(app.identity))
          throw new Error(`Conflicting definitions for application “${prior.name}”.`);
        identities.set(app.identity.id, app.identity);
      }
    }
  }
  return [...identities.values()].sort((a, b) => a.name.localeCompare(b.name));
}

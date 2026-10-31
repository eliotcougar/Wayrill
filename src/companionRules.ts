import type { GraphState } from './graph/types';
import { editGraphNode } from './graph/nodeEditing';
import { domainProblem, readRuleTable, routingListEntries, tableSettings } from './graph/rules';
import { editSourcedRule } from './graph/trafficRuleSource';
import { sourceEntryKey } from './graph/ruleSourceEdits';
import { LIMITS } from './limits';

export interface CompanionRuleRequest {
  host: string;
  filterIds: string[];
}
export interface DomainAddition {
  filterId: string;
  ruleId: string;
  entry: string;
  newRule?: { name: string; output: string };
}
export function domainEntryProblem(entry: string): string | null {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(entry.trim()))
    return 'Enter a domain condition rather than a URL.';
  if (
    !entry.trim() ||
    entry.length > 4096 ||
    /[\r\n\0]/.test(entry) ||
    routingListEntries(entry, 'domain').length !== 1
  )
    return 'Enter one domain condition, up to 4,096 characters.';
  return domainProblem(entry.trim());
}
/** A targeted edit against the current graph, never a replacement of a captured draft. */
export function addCompanionDomain(graph: GraphState, addition: DomainAddition): GraphState {
  const problem = domainEntryProblem(addition.entry);
  if (problem) throw new Error(problem);
  const entry = addition.entry.trim();
  const node = graph.nodes.find(
    (node) => node.id === addition.filterId && node.data.kind === 'routing-filter',
  );
  if (!node) throw new Error('This traffic filter is no longer available.');
  const table = readRuleTable(node.data.settings);
  if (addition.newRule) {
    if (table.rules.length >= LIMITS.maxRoutingRules)
      throw new Error('This filter has reached its rule limit.');
    if (!table.outputs.some((output) => output.id === addition.newRule?.output))
      throw new Error('Choose an available output.');
    const rule = {
      id: crypto.randomUUID(),
      name: addition.newRule.name.trim().slice(0, 128) || 'Domain rule',
      enabled: true,
      output: addition.newRule.output,
      matchAll: false,
      conditions: { domain: entry },
    };
    const fallback = table.rules.findIndex((row) => row.enabled && row.matchAll);
    table.rules.splice(fallback < 0 ? table.rules.length : fallback, 0, rule);
  } else {
    const index = table.rules.findIndex((rule) => rule.id === addition.ruleId);
    if (index < 0) throw new Error('This rule is no longer available.');
    const rule = table.rules[index];
    if (rule.matchAll) throw new Error('Choose a conditional rule or create a new rule.');
    const before = rule.conditions.domain ?? '';
    if (
      routingListEntries(before, 'domain').some(
        (value) => sourceEntryKey(value, 'domain') === sourceEntryKey(entry, 'domain'),
      )
    )
      throw new Error('This entry is already in the selected rule.');
    const domain = `${before.trimEnd()}${before.trim() ? '\n' : ''}${entry}`;
    if (domain.length > 16384) throw new Error('The selected rule has too many domain entries.');
    table.rules[index] = editSourcedRule(rule, { conditions: { ...rule.conditions, domain } });
  }
  return editGraphNode(graph, node.id, {
    settings: { ...node.data.settings, ...tableSettings(table) },
  });
}

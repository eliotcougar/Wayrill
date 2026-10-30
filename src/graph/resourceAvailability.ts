import type { ResourceWarningReport } from '../serviceClient';
import type { GraphState, RuleNode } from './types';
import { resourceCompilationGraph } from './resources';
import { readRuleTable, captureRuleVariants, listEntries } from './rules';
import type { DnsRoute, DnsPolicy } from './dns';
import { parseJson } from './xrayJson';

/** Identify runtime-only skips without changing authored enable switches or saved terms.
 * Only confirmed missing selectors participate. A truncated report never guesses.
 */
export function unavailableRuleIds(
  node: RuleNode,
  graph: GraphState,
  report?: Partial<ResourceWarningReport> | null,
): Set<string> {
  const unavailable = new Set(report?.skippedSelectors?.map((item) => item.selector));
  const ids = new Set<string>();
  if (!unavailable.size) return ids;
  const projected = resourceCompilationGraph({ ...graph, nodes: [node] }).nodes[0];
  const empty = (value: unknown) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((term) => unavailable.has(String(term)));
  if (node.data.kind === 'routing-filter') {
    for (const rule of readRuleTable(projected.data.settings).rules) {
      if (
        rule.enabled &&
        captureRuleVariants(rule, 'shared').every((variant) =>
          ['domain', 'ip', 'sourceIP', 'localIP'].some((key) => empty(variant[key])),
        )
      )
        ids.add(rule.id);
    }
  } else if (node.data.kind === 'dns-routing-filter') {
    for (const rule of parseJson(String(projected.data.settings.rules)) as DnsRoute[]) {
      if (
        rule.enabled &&
        (empty(listEntries(rule.domains)) ||
          empty(listEntries(rule.expectedIPs)) ||
          listEntries(rule.unexpectedIPs).some((term) => unavailable.has(term)))
      )
        ids.add(rule.id);
    }
  } else if (node.data.kind === 'dns-handler') {
    for (const rule of parseJson(String(projected.data.settings.policyRules)) as DnsPolicy[])
      if (rule.enabled && empty(listEntries(rule.domain))) ids.add(rule.id);
  }
  return ids;
}

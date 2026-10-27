import { isDisabledInbound } from './inboundState';
import { parseJson } from './xrayJson';
import { routingListEntries, type TableRule } from './rules';
import type { DnsRoute, DnsPolicy } from './dns';
import type { Diagnostic, GraphState } from './types';

/** Link core asset failures back to the user's rows; keep the original log available. */
export function coreResourceFailure(graph: GraphState, error: string) {
  if (
    !/geo(?:site|ip)|\.dat\b/i.test(error) ||
    !/failed|not found|EOF|unable|cannot|rejected/i.test(error)
  )
    return null;
  const issues: Diagnostic[] = [];
  const referenced = (text: string) =>
    [...text.matchAll(/(?:geosite|geoip):([^\s,"\\]+)|ext(?:-ip)?:[^:\s,"\\]+:([^\s,"\\]+)/g)]
      .map((m) => m[1] ?? m[2])
      .filter((code) => error.toLowerCase().includes(code.split('@')[0].toLowerCase()));
  for (const node of graph.nodes) {
    if (isDisabledInbound(node.data)) continue;
    const add = (name: string, text: string, rowId?: string, fieldKey = 'json') => {
      for (const code of referenced(text))
        issues.push({
          severity: 'error',
          nodeId: node.id,
          rowId,
          fieldKey,
          message: `${node.data.label} / ${name}: resource set ${code} is unavailable. Choose a dataset containing it in Resource files, or change this rule.`,
        });
    };
    try {
      if (node.data.kind === 'routing-filter')
        for (const row of (parseJson(String(node.data.settings.rules)) as TableRule[]).filter(
          (r) => r.enabled,
        )) {
          add(
            row.name,
            routingListEntries(row.conditions.domain ?? '', 'domain').join('\n'),
            row.id,
            'domain',
          );
          add(row.name, routingListEntries(row.conditions.ip ?? '', 'ip').join('\n'), row.id, 'ip');
        }
      else if (node.data.kind === 'dns-routing-filter')
        for (const row of (parseJson(String(node.data.settings.rules)) as DnsRoute[]).filter(
          (r) => r.enabled,
        )) {
          add(row.name, row.domains, row.id, 'domains');
          add(row.name, row.expectedIPs + ' ' + row.unexpectedIPs, row.id, 'expectedIPs');
        }
      else if (node.data.kind === 'dns-handler')
        for (const row of (parseJson(String(node.data.settings.policyRules)) as DnsPolicy[]).filter(
          (r) => r.enabled,
        ))
          add(row.name, row.domain, row.id, 'domain');
      else add(node.data.label, JSON.stringify(node.data.settings));
    } catch {
      /* Draft validation handles unfinished rows. */
    }
  }
  return {
    message:
      'Xray could not load a required routing resource. Check the selected dataset and its available sets in Resource files.',
    issues,
  };
}

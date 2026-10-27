import { jsonText } from '../graph/xrayJson';
import { outboundNodeIndex } from '../graph/nativePool';
import {
  routingListEntries,
  listEntries,
  routingConditionFields,
  type TableRule,
} from '../graph/rules';
import {
  policyReferenceSet,
  readPolicySources,
  type PolicyReference,
} from '../graph/policySources';
import type { GraphState, RuleNode } from '../graph/types';

export function summarizeTerms(value: string): string {
  const terms = listEntries(value);
  const first = terms
    .slice(0, 2)
    .map((term) => (term.length > 65 ? `${term.slice(0, 62)}…` : term));
  // Xray can aggregate inverse CIDR/GeoIP rules before negating them. Do not
  // misrepresent a native inverse list as a simple OR of each textual entry.
  const inverse = terms.some((term) => term.includes('!'));
  return (
    first.join(inverse ? ' · ' : ' OR ') +
    (terms.length > 2 ? ` (+${terms.length - 2})` : '') +
    (inverse ? ' (native list)' : '')
  );
}
export function ruleConditionSummary(rule: TableRule): string {
  if (rule.matchAll) return 'Match all traffic';
  const targets: string[] = [];
  const parts = routingConditionFields.flatMap((field) => {
    const raw = rule.conditions[field.key]?.trim();
    const value =
      raw && ['domain', 'ip'].includes(field.key)
        ? routingListEntries(raw, field.key).join('\n')
        : raw;
    if (value && ['domain', 'ip', 'process'].includes(field.key) && rule.targetMatch !== 'all') {
      targets.push(`${field.label}: ${field.list ? summarizeTerms(value) : value}`);
      return [];
    }
    return value
      ? [
          `${field.label}: ${field.list ? summarizeTerms(value) : value.length > 100 ? `${value.slice(0, 97)}…` : value}`,
        ]
      : [];
  });
  const apps = rule.applications?.filter((r) => r.enabled) ?? [];
  if (apps.length)
    (rule.targetMatch === 'all' ? parts : targets).push(
      `Applications: ${apps
        .slice(0, 2)
        .map((r) => r.value + (r.children ? ' + children' : ''))
        .join(' OR ')}${apps.length > 2 ? ` (+${apps.length - 2})` : ''}`,
    );
  if (targets.length) parts.unshift(targets.length > 1 ? `(${targets.join(' OR ')})` : targets[0]);
  return parts.join(' AND ') || 'No condition · needs attention';
}
export const policyReferenceKey = (ref: PolicyReference) =>
  ref.type === 'node' ? `node:${ref.nodeId}` : `profile:${ref.id}`;

// Presentation only: use the same membership/deduplication operation as the compiler.
export function policySetSummary(
  graph: GraphState,
  node: RuleNode,
  sources = readPolicySources(node.data),
) {
  const entries = policyReferenceSet(graph, node, sources);
  const mode = node.data.settings.selection;
  const manual = mode === 'manual' || mode === 'combined' ? sources.manual : [];
  const subscriptions = mode === 'subscription' || mode === 'combined' ? sources.subscriptions : [];
  const raw = [
    ...manual.map((reference) => ({ reference, origin: 'Manual set' })),
    ...subscriptions.flatMap((s) => s.entries.map((reference) => ({ reference, origin: s.name }))),
  ];
  const origins = new Map<string, Set<string>>();
  for (const { reference, origin } of raw) {
    const key = policyReferenceKey(reference);
    if (!origins.has(key)) origins.set(key, new Set());
    origins.get(key)!.add(origin);
  }
  return {
    entries: entries.map((entry) => ({
      ...entry,
      origins: [...(origins.get(policyReferenceKey(entry.reference)) ?? [entry.origin])],
    })),
    manual: manual.length,
    subscription: subscriptions.reduce((count, source) => count + source.entries.length, 0),
    duplicates: mode === 'prefixes' ? 0 : raw.length - entries.length,
    rejected: subscriptions.reduce((count, source) => count + source.rejected, 0),
  };
}

export function referenceSummary(graph: GraphState, reference: PolicyReference) {
  const node =
    reference.type === 'node' ? outboundNodeIndex(graph).get(reference.nodeId) : undefined;
  const kind = reference.type === 'profile' ? reference.profile.kind : node?.data.kind;
  const settings = reference.type === 'profile' ? reference.profile.settings : node?.data.settings;
  const native = node?.data.native?.original;
  const nativeSettings = native?.settings as Record<string, unknown> | undefined;
  return {
    name: reference.type === 'profile' ? reference.name : (node?.data.label ?? 'Missing outbound'),
    protocol: jsonText(
      kind === 'policy-group'
        ? 'Policy group'
        : kind === 'proxy-chain'
          ? 'Proxy chain'
          : kind === 'xray-outbound'
            ? (native?.protocol ?? 'Xray')
            : (kind ?? '').replace('-outbound', ''),
    ),
    address: jsonText(settings?.address ?? settings?.redirect ?? nativeSettings?.address ?? ''),
    tag:
      reference.type === 'profile'
        ? String(settings?.tag ?? '')
        : String(node?.data.settings.tag ?? ''),
  };
}

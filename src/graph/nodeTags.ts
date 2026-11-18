import { getDefinition } from './catalog';
import { effectiveDefaults } from './defaults';
import { isInboundKind } from './inbounds';
import { isOutboundKind } from './outbounds';
import { nativeKey, nativeValue } from '@wayrill/core/nativeProperties';
import { jsonArray, jsonRecord, parseXrayJson } from './xrayJson';
import { GENERATED_DNS_TAG, isGeneratedTag, nodeTag } from './tags';
import type { GraphState, RuleNodeData } from './types';

export type TagNamespace = 'inbound' | 'outbound' | 'balancer';
export const DEFAULT_METRICS_TAG = 'metrics';

function nativeTagRoot(data: RuleNodeData) {
  try {
    const root = parseXrayJson(String(data.settings.json));
    if (jsonRecord(root)) return root;
  } catch {
    /* The native editor reports invalid JSON. */
  }
}

export function editableTag(data: RuleNodeData, id: string) {
  const { settings, kind } = data;
  if (typeof settings.tag === 'string') {
    const namespace: TagNamespace =
      isInboundKind(kind) || kind === 'xray-inbound'
        ? 'inbound'
        : kind === 'policy-group'
          ? 'balancer'
          : 'outbound';
    if (namespace === 'outbound' && !isOutboundKind(kind) && kind !== 'dns-handler') return;
    return {
      value: settings.tag,
      automatic: nodeTag(data, id),
      namespace,
      maxLength: getDefinition(kind).fields.find((field) => field.key === 'tag')?.maxLength ?? 128,
      settingsFor: (tag: string) => ({ ...settings, tag }),
    };
  }
  if (kind !== 'xray-dns' && kind !== 'xray-options') return;
  const root = nativeTagRoot(data);
  if (!root) return;
  const dns = kind === 'xray-dns';
  const object = dns ? root : nativeValue(root, 'metrics');
  if (!jsonRecord(object)) return;
  const key = nativeKey(object, 'tag');
  const namespace: TagNamespace = dns ? 'inbound' : 'outbound';
  return {
    value: typeof object[key] === 'string' ? object[key] : '',
    automatic: dns ? GENERATED_DNS_TAG : DEFAULT_METRICS_TAG,
    namespace,
    maxLength: 4096,
    settingsFor: (tag: string) => ({
      ...settings,
      json: JSON.stringify(
        dns
          ? { ...object, [key]: tag }
          : {
              ...root,
              [nativeKey(root, 'metrics')]: { ...object, [key]: tag },
            },
        null,
        2,
      ),
    }),
  };
}

export function occupiedTags(
  graph: GraphState,
  namespace: TagNamespace,
  exceptId?: string,
  includeGlobalMetrics = true,
) {
  const tags = new Set<string>();
  for (const node of graph.nodes) {
    const { data } = node;
    if (node.id !== exceptId) {
      const tag = editableTag(data, node.id);
      if (tag?.namespace === namespace && tag.value) tags.add(tag.value);
    }
    if (namespace === 'inbound' && (data.kind === 'xray-dns' || data.kind === 'xray-dns-servers')) {
      const root = nativeTagRoot(data);
      const servers = root && nativeValue(root, 'servers');
      if (jsonArray(servers)) {
        for (const server of servers) {
          const tag = jsonRecord(server) && nativeValue(server, 'tag');
          if (typeof tag === 'string' && tag) tags.add(tag);
        }
      }
    }
  }
  if (namespace === 'outbound') {
    for (const node of graph.xray?.outboundPool ?? []) {
      if (typeof node.config.tag === 'string') tags.add(node.config.tag);
    }
    if (includeGlobalMetrics && !graph.xray && graph.defaults) {
      const defaults = effectiveDefaults(graph.defaults);
      if (defaults.metricsEnabled && defaults.metricsTag) tags.add(String(defaults.metricsTag));
    }
  }
  return tags;
}

export function availableAutomaticTag(automatic: string, used: ReadonlySet<string>) {
  if (!used.has(automatic)) return automatic;
  let suffix = 2;
  while (used.has(`${automatic}-${suffix}`)) suffix++;
  return `${automatic}-${suffix}`;
}

export function tagOverrideProblem(
  value: string,
  automatic: string,
  used: ReadonlySet<string>,
  maxLength: number,
): string | undefined {
  if (!value) return 'Enter a tag.';
  if (value.length > maxLength) return `Use at most ${maxLength} characters.`;
  if (/\p{Cc}/u.test(value) || value.includes('>>>'))
    return 'Tags cannot contain control characters or >>>.';
  if (value !== automatic && isGeneratedTag(value)) return 'This tag prefix is reserved.';
  if (used.has(value)) return 'This tag is already used.';
}

import { getDefinition } from './catalog';
import { nativePoolNodes } from './nativePool';
import { generatedTag, GENERATED_DNS_TAG, ensureNodeTags } from './tags';
import { readDnsServers } from './dns';
import { effectiveDefaults } from './defaults';
import { jsonArray, jsonRecord, parseXrayJson } from './xrayJson';
import type { GraphState, RuleNode } from './types';
import { isDisabledInbound } from './inboundState';
import { nativeValue } from './protocols';
import { isXrayOutbound } from './xrayNodes';

export type TagReferenceKind = 'inbound' | 'outbound' | 'dialer';
export type TagChoice = { tag: string; name: string; detail: string };

const endpoints = new WeakMap<
  RuleNode['data']['settings'],
  { values: unknown[]; endpoint: string }
>();
function configuredEndpoint(node: RuleNode): string {
  const s = node.data.settings,
    values = [s.json, s.address, s.listen, s.port, s.redirect];
  const cached = endpoints.get(s);
  if (cached && values.every((value, index) => value === cached.values[index]))
    return cached.endpoint;
  let address: unknown = s.address || s.listen || s.redirect,
    port: unknown = s.port;
  if (s.json)
    try {
      const raw: unknown = parseXrayJson(String(s.json));
      if (jsonRecord(raw)) {
        const settings = nativeValue(raw, 'settings');
        let target = jsonRecord(settings) ? settings : {};
        for (const key of ['servers', 'vnext', 'peers']) {
          const rows = nativeValue(target, key);
          if (jsonArray(rows) && jsonRecord(rows[0])) {
            target = rows[0];
            break;
          }
        }
        address =
          nativeValue(raw, 'listen') ??
          nativeValue(target, 'address') ??
          nativeValue(target, 'endpoint') ??
          nativeValue(target, 'redirect') ??
          address;
        port = nativeValue(raw, 'port') ?? nativeValue(target, 'port') ?? port;
      }
    } catch {
      /* Incomplete drafts still have a name and node type. */
    }
  const host = typeof address === 'string' ? address : '';
  const endpoint = host
    ? host + ((typeof port === 'number' || typeof port === 'string') && port ? ':' + port : '')
    : '';
  endpoints.set(s, { values, endpoint });
  return endpoint;
}

export function nodeReferenceDetail(node: RuleNode, graph: GraphState): string {
  const endpoint = configuredEndpoint(node);
  const ambiguous = graph.nodes.some(
    (other) =>
      other.id !== node.id &&
      other.data.label === node.data.label &&
      other.data.kind === node.data.kind &&
      configuredEndpoint(other) === endpoint,
  );
  return [
    getDefinition(node.data.kind).title,
    endpoint,
    isDisabledInbound(node.data) && 'Disabled',
    ambiguous && `ID ${node.id.slice(-8)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function tagReferenceKind(key: string): TagReferenceKind | undefined {
  if (key === 'inboundTag') return 'inbound';
  if (key === 'dialerProxy') return 'dialer';
  if (key === 'selectorPrefixes') return 'outbound';
}

export function tagReferenceLabel(key: string, fallback: string): string {
  return key === 'dialerProxy'
    ? 'Connect through outbound'
    : key === 'inboundTag'
      ? 'Target inbound'
      : fallback;
}

/** Include native DNS query sources and hidden imported destinations as well as cards. */
export function graphTagChoices(
  graph: GraphState,
  kind: TagReferenceKind,
  excludeId?: string,
): TagChoice[] {
  graph = ensureNodeTags(graph);
  const choices = new Map<string, TagChoice>();
  const add = (tag: unknown, name: string, detail: string) => {
    if (typeof tag === 'string' && tag && !choices.has(tag))
      choices.set(tag, { tag, name, detail });
  };
  for (const node of [...graph.nodes, ...(kind !== 'inbound' ? nativePoolNodes(graph) : [])]) {
    if (kind !== 'inbound' && node.id === excludeId) continue;
    const { data } = node,
      definition = getDefinition(data.kind);
    if (
      kind === 'inbound'
        ? definition.category === 'inbound'
        : kind === 'dialer'
          ? isXrayOutbound(node)
          : definition.category === 'outbound' &&
            !['dns-servers', 'xray-dns-servers', 'policy-group'].includes(data.kind)
    )
      add(data.settings.tag, data.label, nodeReferenceDetail(node, graph));
    if (kind === 'inbound' && data.kind === 'dns-handler')
      add(GENERATED_DNS_TAG, data.label + ' · queries', 'DNS query source');
    if (kind === 'inbound' && data.kind === 'dns-servers') {
      try {
        for (const server of readDnsServers(data.settings).filter((server) => server.enabled))
          add(
            generatedTag('wds', node.id, server.id),
            `${data.label} · ${server.name || server.address}`,
            'DNS query source',
          );
      } catch {
        /* Invalid entries are reported by their editor. */
      }
    }
    if (['xray-dns', 'xray-dns-servers', 'xray-options'].includes(data.kind)) {
      try {
        const object: unknown = parseXrayJson(String(data.settings.json));
        if (!jsonRecord(object)) continue;
        if (kind === 'inbound' && data.kind !== 'xray-options') {
          add(object.tag, data.label + ' · queries', 'DNS query source');
          if (jsonArray(object.servers))
            object.servers.forEach((server, index) => {
              if (jsonRecord(server))
                add(
                  server.tag,
                  `${data.label} · ${typeof server.address === 'string' ? server.address : index + 1}`,
                  'DNS query source',
                );
            });
        }
        if (kind === 'outbound' && jsonRecord(object.metrics))
          add(object.metrics.tag, 'Metrics', 'Core metrics');
      } catch {
        /* Invalid JSON is reported by its editor. */
      }
    }
  }
  const defaults = graph.defaults && effectiveDefaults(graph.defaults);
  if (kind === 'outbound' && defaults?.metricsEnabled)
    add(defaults.metricsTag, 'Metrics', 'Core metrics');
  return [...choices.values()];
}

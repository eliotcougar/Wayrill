import type { NodeKind } from './graph/types';
import { getDefinition } from './graph/catalog';

/** UI vocabulary follows Wayrill; native Xray identifiers stay in JSON and settings. */
export function nodeTypeLabel(kind: NodeKind, protocol?: string) {
  const labels: Partial<Record<NodeKind, string>> = {
    'xray-options': 'Core settings',
    'xray-dns': 'DNS handler',
    'xray-dns-servers': 'DNS server(s)',
    'routing-filter': 'Routing filter',
  };
  if (labels[kind]) return labels[kind];
  if (
    protocol &&
    ['socks', 'http', 'mixed'].includes(protocol) &&
    String(kind).endsWith('-inbound')
  )
    return `Proxy inbound · ${protocol === 'mixed' ? 'Mixed' : protocol.toUpperCase()}`;
  return getDefinition(kind).title;
}
export function editorTitle(schema: string, title: string) {
  return schema === 'BalancingRule'
    ? `Edit Group · ${title}`
    : schema === 'Config'
      ? 'Core settings'
      : `Edit · ${title}`;
}
export function navigationGroup(data: { category: string; raw: unknown }) {
  if (data.category === 'users') return 'User sets';
  if (data.category === 'internal') return 'Internal';
  if (data.category === 'outbound') return 'Outbounds';
  if (data.category === 'inbound')
    return data.raw &&
      typeof data.raw === 'object' &&
      'protocol' in data.raw &&
      data.raw.protocol === 'tun'
      ? 'Local capture'
      : 'Inbounds';
  return 'Rules & filters';
}

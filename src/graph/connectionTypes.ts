import { isExecutableOutboundKind, isOutboundKind } from './outbounds';
import { isInboundKind } from './inbounds';
import { FAKE_DNS_PORT } from './fakeDns';
import type { RuleNodeData } from './types';
import { connectionTypes, type ConnectionKind } from './connectionKinds';

export { connectionTypes, type ConnectionKind } from './connectionKinds';

export function sourceConnectionKind(data: RuleNodeData, port: string): ConnectionKind {
  if (port === 'observation' && isOutboundKind(data.kind)) return 'observation';
  if (
    data.kind === 'dns-routing-filter' ||
    data.kind === 'xray-dns' ||
    (data.kind === 'dns-handler' && port === 'resolver')
  )
    return 'resolver';
  if (
    data.kind === 'dns-servers' ||
    data.kind === 'xray-dns-servers' ||
    (data.kind === 'dns-handler' && port === 'forward') ||
    (isInboundKind(data.kind) && ['dns', 'nat-dns', 'encrypted-dns'].includes(port))
  )
    return 'dns-traffic';
  return 'traffic';
}

export function targetConnectionKinds(data: RuleNodeData): readonly ConnectionKind[] {
  if (data.kind === 'observatory') return ['observation'];
  if (['dns-routing-filter', 'dns-servers', 'xray-dns-servers', 'fakedns'].includes(data.kind))
    return ['resolver'];
  if (isExecutableOutboundKind(data.kind) || data.kind === 'xray-outbound')
    return ['traffic', 'dns-traffic'];
  if (['routing-filter', 'dns-handler', 'policy-group', 'proxy-chain'].includes(data.kind))
    return ['traffic', 'dns-traffic'];
  return [];
}

export function typedConnectionProblem(
  source: RuleNodeData,
  port: string,
  target: RuleNodeData,
): string | null {
  const kind = sourceConnectionKind(source, port);
  if (source.kind === 'dns-routing-filter' && port === FAKE_DNS_PORT)
    return target.kind === 'fakedns' ? null : 'Connect the FakeDNS output to a FakeDNS node.';
  if (target.kind === 'dns-handler' && port === 'encrypted-dns')
    return 'Encrypted DNS must be forwarded to an outbound or policy group. The DNS handler cannot decrypt TLS/QUIC.';
  if (target.kind === 'dns-handler' && kind === 'traffic' && source.kind !== 'routing-filter')
    return 'Connect the input’s DNS output to a DNS handler.';
  if (kind === 'observation')
    return target.kind === 'observatory'
      ? null
      : 'Connect the Observation port to an observatory node.';
  if (target.kind === 'observatory')
    return 'An observatory accepts observation connections from outbounds.';
  if (kind === 'resolver') {
    const allowed =
      source.kind === 'xray-dns'
        ? target.kind === 'xray-dns-servers' || target.kind === 'fakedns'
        : target.kind === 'dns-servers' ||
          target.kind === 'fakedns' ||
          (source.kind === 'dns-handler' && target.kind === 'dns-routing-filter');
    return allowed
      ? null
      : 'Connect a resolver path to a compatible DNS routing filter or DNS server(s).';
  }
  if (['dns-routing-filter', 'dns-servers', 'xray-dns-servers', 'fakedns'].includes(target.kind))
    return 'DNS resolver nodes accept resolver-selection connections only.';
  if (source.kind === 'xray-dns-servers')
    return target.kind === 'routing-filter'
      ? null
      : 'Native DNS query traffic follows the global routing filter.';
  if (source.kind === 'dns-servers' && target.kind === 'policy-group') return null;
  if (source.kind === 'dns-servers' || (source.kind === 'dns-handler' && port === 'forward'))
    return isExecutableOutboundKind(target.kind) ||
      target.kind === 'xray-outbound' ||
      target.kind === 'proxy-chain'
      ? null
      : 'Connect DNS query traffic to a configured Direct, VLESS or Block outbound.';
  return targetConnectionKinds(target).includes(kind)
    ? null
    : `This input does not accept ${connectionTypes[kind].label.toLowerCase()} connections.`;
}

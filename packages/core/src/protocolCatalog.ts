export type ProtocolInboundKind =
  | 'tunnel-inbound'
  | 'vless-inbound'
  | 'vmess-inbound'
  | 'trojan-inbound'
  | 'shadowsocks-inbound'
  | 'wireguard-inbound'
  | 'hysteria-inbound'
  | 'masque-inbound'
  | 'tun-inbound'
  | 'ics-tun';
export type ProtocolOutboundKind =
  | 'http-outbound'
  | 'vmess-outbound'
  | 'trojan-outbound'
  | 'shadowsocks-outbound'
  | 'wireguard-outbound'
  | 'hysteria-outbound'
  | 'masque-outbound'
  | 'loopback-outbound'
  | 'dns-outbound';
export type ProtocolKind = ProtocolInboundKind | ProtocolOutboundKind;
export interface ProtocolSpec<Kind extends string = string, Structure extends string = string> {
  kind: Kind;
  protocol: string;
  title: string;
  direction: 'inbound' | 'outbound';
  structure: Structure;
  aliases?: readonly string[];
  note?: string;
}
export const protocolSpecs = [
  {
    kind: 'tunnel-inbound',
    protocol: 'tunnel',
    title: 'Tunnel',
    direction: 'inbound',
    structure: 'DokodemoConfig',
    aliases: ['dokodemo-door'],
    note: 'Forwards TCP/UDP to a configured destination or the original destination. followRedirect needs platform capture support; this node does not install capture rules.',
  },
  {
    kind: 'proxy-inbound',
    protocol: 'mixed',
    title: 'Proxy',
    direction: 'inbound',
    structure: 'SocksServerConfig',
  },
  {
    kind: 'proxy-inbound',
    protocol: 'socks',
    title: 'Proxy',
    direction: 'inbound',
    structure: 'SocksServerConfig',
  },
  {
    kind: 'proxy-inbound',
    protocol: 'http',
    title: 'Proxy',
    direction: 'inbound',
    structure: 'HTTPServerConfig',
  },
  {
    kind: 'vless-inbound',
    protocol: 'vless',
    title: 'VLESS',
    direction: 'inbound',
    structure: 'VLessInboundConfig',
  },
  {
    kind: 'vmess-inbound',
    protocol: 'vmess',
    title: 'VMess',
    direction: 'inbound',
    structure: 'VMessInboundConfig',
  },
  {
    kind: 'trojan-inbound',
    protocol: 'trojan',
    title: 'Trojan',
    direction: 'inbound',
    structure: 'TrojanServerConfig',
  },
  {
    kind: 'shadowsocks-inbound',
    protocol: 'shadowsocks',
    title: 'Shadowsocks',
    direction: 'inbound',
    structure: 'ShadowsocksServerConfig',
  },
  {
    kind: 'wireguard-inbound',
    protocol: 'wireguard',
    title: 'WireGuard',
    direction: 'inbound',
    structure: 'WireGuardConfig',
    note: 'Uses Xray’s userspace WireGuard stack on Windows. Peers define authentication and allowed source addresses.',
  },
  {
    kind: 'hysteria-inbound',
    protocol: 'hysteria',
    title: 'Hysteria 2',
    direction: 'inbound',
    structure: 'HysteriaServerConfig',
  },
  {
    kind: 'masque-inbound',
    protocol: 'masque',
    title: 'MASQUE',
    direction: 'inbound',
    structure: 'MasqueServerConfig',
  },
  {
    kind: 'tun-inbound',
    protocol: 'tun',
    title: 'TUN adapter',
    direction: 'inbound',
    structure: 'TunConfig',
    note: 'Capture this PC through a service-managed Windows adapter.',
  },
  {
    kind: 'ics-tun',
    protocol: 'tun',
    title: 'ICS TUN',
    direction: 'inbound',
    structure: 'TunConfig',
    note: 'Route Windows Internet sharing through its own traffic path.',
  },
  {
    kind: 'direct-outbound',
    protocol: 'freedom',
    title: 'Direct',
    direction: 'outbound',
    structure: 'FreedomConfig',
    aliases: ['direct'],
  },
  {
    kind: 'block-outbound',
    protocol: 'blackhole',
    title: 'Block',
    direction: 'outbound',
    structure: 'BlackholeConfig',
    aliases: ['block'],
  },
  {
    kind: 'socks-outbound',
    protocol: 'socks',
    title: 'SOCKS',
    direction: 'outbound',
    structure: 'SocksClientConfig',
  },
  {
    kind: 'vless-outbound',
    protocol: 'vless',
    title: 'VLESS',
    direction: 'outbound',
    structure: 'VLessOutboundConfig',
  },
  {
    kind: 'http-outbound',
    protocol: 'http',
    title: 'HTTP CONNECT',
    direction: 'outbound',
    structure: 'HTTPClientConfig',
  },
  {
    kind: 'vmess-outbound',
    protocol: 'vmess',
    title: 'VMess',
    direction: 'outbound',
    structure: 'VMessOutboundConfig',
  },
  {
    kind: 'trojan-outbound',
    protocol: 'trojan',
    title: 'Trojan',
    direction: 'outbound',
    structure: 'TrojanClientConfig',
  },
  {
    kind: 'shadowsocks-outbound',
    protocol: 'shadowsocks',
    title: 'Shadowsocks',
    direction: 'outbound',
    structure: 'ShadowsocksClientConfig',
  },
  {
    kind: 'wireguard-outbound',
    protocol: 'wireguard',
    title: 'WireGuard',
    direction: 'outbound',
    structure: 'WireGuardConfig',
  },
  {
    kind: 'hysteria-outbound',
    protocol: 'hysteria',
    title: 'Hysteria 2',
    direction: 'outbound',
    structure: 'HysteriaClientConfig',
  },
  {
    kind: 'masque-outbound',
    protocol: 'masque',
    title: 'MASQUE',
    direction: 'outbound',
    structure: 'MasqueClientConfig',
    note: 'CONNECT-IP over HTTP/3. Credentials belong to masqueSettings. Xray rejects mux for this protocol.',
  },
  {
    kind: 'loopback-outbound',
    protocol: 'loopback',
    title: 'Loopback',
    direction: 'outbound',
    structure: 'LoopbackConfig',
    note: 'Reinjects traffic with the chosen inbound tag. Routing rules must terminate that traffic instead of returning it to this same loopback.',
  },
  {
    kind: 'dns-outbound',
    protocol: 'dns',
    title: 'DNS',
    direction: 'outbound',
    structure: 'DNSOutboundConfig',
    note: 'A DNS traffic handler, distinct from the global DNS resolver settings. Rewrite settings and request rules use native Xray semantics.',
  },
] as const satisfies readonly ProtocolSpec[];
export const protocolInboundKinds = [
  'tunnel-inbound',
  'vless-inbound',
  'vmess-inbound',
  'trojan-inbound',
  'shadowsocks-inbound',
  'wireguard-inbound',
  'hysteria-inbound',
  'masque-inbound',
  'tun-inbound',
  'ics-tun',
] as const;
export const protocolOutboundKinds = [
  'http-outbound',
  'vmess-outbound',
  'trojan-outbound',
  'shadowsocks-outbound',
  'wireguard-outbound',
  'hysteria-outbound',
  'masque-outbound',
  'loopback-outbound',
  'dns-outbound',
] as const;
export const isProtocolInbound = (kind: string): kind is ProtocolInboundKind =>
  protocolInboundKinds.some((value) => value === kind);
export const isProtocolOutbound = (kind: string): kind is ProtocolOutboundKind =>
  protocolOutboundKinds.some((value) => value === kind);
export const isProtocolKind = (kind: string): kind is ProtocolKind =>
  isProtocolInbound(kind) || isProtocolOutbound(kind);

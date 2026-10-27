import { jsonArray, jsonRecord, jsonText } from './xrayJson';
import { nativeValue } from './protocols';
export type SocketNetwork = 'tcp' | 'udp';
const record = (value: unknown) => (jsonRecord(value) ? value : {});

/** Physical listener sockets, not the TCP/UDP payload carried by a proxy. */
export function listenerNetworks(input: Record<string, unknown>): SocketNetwork[] {
  const protocol = jsonText(nativeValue(input, 'protocol')).toLowerCase();
  if (!protocol || protocol === 'tun') return [];
  if (protocol === 'wireguard') return ['udp'];
  const stream = record(nativeValue(input, 'streamSettings'));
  const transport = jsonText(
    nativeValue(stream, 'method') ?? nativeValue(stream, 'network') ?? 'raw',
  ).toLowerCase();
  const alpn =
    nativeValue(stream, 'security') === 'tls'
      ? nativeValue(record(nativeValue(stream, 'tlsSettings')), 'alpn')
      : undefined;
  const protocols = jsonArray(alpn) ? alpn : typeof alpn === 'string' ? alpn.split(',') : [];
  const tcpTransport = (): SocketNetwork[] => {
    if (['kcp', 'hysteria'].includes(transport)) return ['udp'];
    if (transport === 'masque') {
      const h2 = protocols.includes('h2');
      return [
        ...(h2 ? ['tcp' as const] : []),
        ...(!h2 || protocols.includes('h3') ? ['udp' as const] : []),
      ];
    }
    if (
      ['xhttp', 'splithttp'].includes(transport) &&
      protocols.length === 1 &&
      protocols[0] === 'h3'
    )
      return ['udp'];
    return ['tcp'];
  };
  if (!['tunnel', 'dokodemo-door', 'shadowsocks'].includes(protocol)) return tcpTransport();
  const settings = record(nativeValue(input, 'settings'));
  const value =
    nativeValue(settings, 'network') ?? nativeValue(settings, 'allowedNetwork') ?? 'tcp';
  const networks = jsonArray(value)
    ? value.map((n) => jsonText(n).toLowerCase())
    : jsonText(value)
        .split(',')
        .map((n) => n.trim().toLowerCase());
  return [
    ...new Set<SocketNetwork>([
      ...(networks.includes('tcp') ? tcpTransport() : []),
      ...(networks.includes('udp') ? ['udp' as const] : []),
    ]),
  ];
}

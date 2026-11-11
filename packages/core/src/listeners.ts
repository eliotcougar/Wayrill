import { jsonText, jsonArray, jsonRecord } from './xrayJson';
import { isIpLiteral } from './addressValidation';
import { nativeValue } from './nativeProperties';

export function listenerProblem(input: Record<string, unknown>): string | null {
  if (input.protocol === 'tun') return null;
  if (input.listen !== 'localhost' && !isIpLiteral(jsonText(input.listen ?? '')))
    return 'Use an IPv4 or IPv6 listen address, or localhost.';
  if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535)
    return 'Listen port must be an integer from 1 to 65535.';
  return null;
}

// Go's unspecified IPv6 socket accepts IPv4 too. Normalize IPv4-mapped IPv6
// and alternate IPv6 spellings so Check and service activation agree.
function canonicalAddress(address: string): string {
  if (address === 'localhost') return '127.0.0.1';
  if (!address.includes(':')) return address;
  try {
    const ip = new URL(`http://[${address.replace(/^\[|\]$/g, '')}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ip);
    if (mapped) {
      const high = parseInt(mapped[1], 16),
        low = parseInt(mapped[2], 16);
      return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
    }
    return ip;
  } catch {
    return address;
  }
}

export function listenerEndpointsConflict(first: string, second: string): boolean {
  const parse = (key: string) => /^(tcp|udp):(.+):(\d+)$/.exec(key);
  const a = parse(first),
    b = parse(second);
  if (!a || !b || a[1] !== b[1] || Number(a[3]) !== Number(b[3])) return false;
  const x = canonicalAddress(a[2]),
    y = canonicalAddress(b[2]);
  return x === y || x === '::' || y === '::' || x === '0.0.0.0' || y === '0.0.0.0';
}

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

// Match the actual socket networks, rather than treating TCP and UDP on one
// numeric port as a collision. Invalid drafts are diagnosed separately.
export function listenerEndpointKeys(input: Record<string, unknown>): string[] {
  let address = jsonText(input.listen ?? '');
  if (address === 'localhost') address = '127.0.0.1';
  else if (address.includes(':'))
    try {
      address = new URL(`http://[${address}]/`).hostname;
    } catch {
      /* Invalid literals have separate field diagnostics. */
    }
  const endpoint = `${address}:${jsonText(input.port)}`;
  return listenerNetworks(input).map((network) => `${network}:${endpoint}`);
}

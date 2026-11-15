import {
  fallbackAddress,
  formatAddress,
  publicPort,
  sameListener,
  type Address,
  type Listener,
} from './nginxConfig';
import type { StreamRelay } from './nginxStream';
import { record, scalarText, settingsOf } from './users/model';
import type { HttpVersion, RelayNetwork, XrayTransport } from './xrayIngress';

export type BoundInbound = {
  index: number;
  bind: Address;
  raw: Record<string, unknown>;
  incoming: XrayTransport;
  networks: RelayNetwork[];
};

export type HttpFront = { port: number; tls: boolean; alpn: HttpVersion; via?: string };

function fallback(inbound: BoundInbound, hostname: string, alpn: string, path: string) {
  const { incoming, raw } = inbound;
  if (incoming.network !== 'raw' || !['vless', 'trojan'].includes(incoming.protocol)) return;
  const configured = settingsOf(raw).fallbacks;
  if (!Array.isArray(configured)) return;
  const entries = configured.map(record).reverse();
  const names = new Set(entries.map((entry) => scalarText(entry.name).toLowerCase()));
  const matched = [...names]
    .filter((name) => name && hostname.toLowerCase().includes(name))
    .sort((a, b) => b.length - a.length);
  if (
    !names.has(hostname.toLowerCase()) &&
    matched.length > 1 &&
    matched[0].length === matched[1].length
  )
    return;
  const name = names.has(hostname.toLowerCase()) ? hostname.toLowerCase() : (matched[0] ?? '');
  const hasAlpn = entries.some(
    (entry) =>
      ['', name].includes(scalarText(entry.name).toLowerCase()) && scalarText(entry.alpn) === alpn,
  );
  const groups = [
    [name, hasAlpn ? alpn : ''],
    [name, ''],
    ['', hasAlpn ? alpn : ''],
    ['', ''],
  ];
  for (const requested of path ? [path, ''] : ['']) {
    for (const [groupName, groupAlpn] of groups) {
      const entry = entries.find(
        (row) =>
          scalarText(row.name).toLowerCase() === groupName &&
          scalarText(row.alpn) === groupAlpn &&
          scalarText(row.path) === requested,
      );
      if (!entry) continue;
      const bind = fallbackAddress(entry.dest);
      if (bind) return { bind, proxyProtocol: [1, 2].includes(Number(entry.xver)) };
      return;
    }
  }
}

/**
 * Follow the decrypted byte stream from a public Xray TLS listener to the
 * local Nginx listener. At a cleartext fallback listener the TLS SNI and
 * negotiated ALPN are no longer visible to that listener.
 */
export function fallbackFronts(
  inbounds: BoundInbound[],
  relays: StreamRelay[],
  listener: Listener,
  hostname: string,
  version: HttpVersion,
  requestPath: string,
) {
  if (listener.tls || version === 'h3') return [];
  const fronts: HttpFront[] = [];
  const path = version === 'http/1.1' && requestPath.length < 55 ? requestPath : '';
  for (const initial of inbounds) {
    if (initial.incoming.security !== 'tls' || !initial.networks.includes('tcp')) continue;
    const alpn = record(initial.incoming.stream.tlsSettings).alpn;
    if (Array.isArray(alpn) && alpn.length && !alpn.includes(version)) continue;
    if (typeof alpn === 'string' && alpn && alpn !== version) continue;
    const ports = relays.flatMap((relay) => {
      const target =
        relay.network === 'tcp' && !relay.tls && !relay.upstreamTls && !relay.localHandoff
          ? relay.target(hostname, [version])
          : undefined;
      return target &&
        sameListener(initial.bind, target) &&
        relay.proxyProtocol === initial.incoming.proxyProtocol
        ? [relay.port]
        : [];
    });
    const direct = publicPort(initial.bind);
    if (direct && !initial.incoming.proxyProtocol) ports.push(direct);
    if (!ports.length) continue;
    let current = initial;
    const visited = new Set<number>();
    const hops = [];
    while (!visited.has(current.index)) {
      visited.add(current.index);
      hops.push(scalarText(current.raw.tag) || formatAddress(current.bind));
      const next = fallback(
        current,
        current === initial ? hostname : '',
        current === initial ? version : '',
        path,
      );
      if (!next) break;
      if (
        sameListener(listener.address, next.bind) &&
        listener.proxyProtocol === next.proxyProtocol
      ) {
        const via = [...hops, formatAddress(listener.address)].join(' → ');
        for (const port of new Set(ports)) fronts.push({ port, tls: true, alpn: version, via });
        break;
      }
      const matches = inbounds.filter(
        ({ bind, incoming, networks }) =>
          sameListener(bind, next.bind) &&
          incoming.security === 'none' &&
          incoming.proxyProtocol === next.proxyProtocol &&
          networks.includes('tcp'),
      );
      if (matches.length !== 1) break;
      current = matches[0];
    }
  }
  return fronts;
}

import { record, scalarText, settingsOf } from './users/model';

export type RelaySecurity = 'none' | 'tls' | 'reality';
export type HttpVersion = 'http/1.1' | 'h2' | 'h3';
export type RelayNetwork = 'tcp' | 'udp';
const aliases = new Map([
  ['tcp', 'raw'],
  ['websocket', 'ws'],
  ['splithttp', 'xhttp'],
  ['mkcp', 'kcp'],
]);

export function xrayTransport(inbound: Record<string, unknown>) {
  const stream = record(inbound.streamSettings);
  const method = (scalarText(stream.method ?? stream.network) || 'raw').toLowerCase();
  const network = aliases.get(method) ?? method;
  const alias =
    network === 'raw'
      ? stream.tcpSettings
      : network === 'xhttp'
        ? stream.splithttpSettings
        : undefined;
  const options = record(stream[network + 'Settings'] ?? alias);
  const security = (scalarText(stream.security) || 'none').toLowerCase();
  return {
    stream,
    network,
    options,
    security,
    protocol: scalarText(inbound.protocol).toLowerCase(),
    // The legacy option is transport-specific. Xray also accepts it through sockopt.
    proxyProtocol:
      record(stream.sockopt).acceptProxyProtocol === true ||
      (['raw', 'ws', 'httpupgrade'].includes(network) && options.acceptProxyProtocol === true),
  };
}

export type XrayTransport = ReturnType<typeof xrayTransport>;
export const relaySecurity = (value: string): value is RelaySecurity =>
  value === 'none' || value === 'tls' || value === 'reality';

export function xrayTlsAlpn(transport: XrayTransport): string[] {
  if (transport.security !== 'tls') return [];
  const alpn = record(transport.stream.tlsSettings).alpn;
  return Array.isArray(alpn)
    ? alpn.filter((value): value is string => typeof value === 'string')
    : typeof alpn === 'string'
      ? alpn.split(',')
      : [];
}

export function xrayRelayNetworks(
  inbound: Record<string, unknown>,
  transport: XrayTransport,
): RelayNetwork[] {
  const { network, protocol, security } = transport;
  if (protocol === 'wireguard') return ['udp'];
  if (network === 'kcp' || network === 'hysteria') return ['udp'];
  const alpn = xrayTlsAlpn(transport);
  if (network === 'masque') {
    if (security !== 'tls') return [];
    if (!alpn.includes('h2')) return ['udp'];
    return alpn.includes('h3') ? ['tcp', 'udp'] : ['tcp'];
  }
  if (network === 'xhttp' && alpn.length === 1 && alpn[0] === 'h3') return ['udp'];
  if (protocol === 'tun') return [];
  if (network === 'raw' && ['shadowsocks', 'tunnel', 'dokodemo-door'].includes(protocol)) {
    const value = settingsOf(inbound).network;
    const networks = Array.isArray(value) ? value : scalarText(value).split(',');
    return networks.some((item) => item === 'tcp' || item === 'udp')
      ? networks.filter((item): item is RelayNetwork => item === 'tcp' || item === 'udp')
      : ['tcp'];
  }
  return ['raw', 'ws', 'httpupgrade', 'xhttp', 'grpc'].includes(network) ? ['tcp'] : [];
}

export function grpcMethods(options: Record<string, unknown>) {
  const service = scalarText(options.serviceName);
  // Keep the comparison in the same URI representation as the literal nginx
  // locations. Names that need URI escaping need an explicit client profile.
  if (!service.startsWith('/')) {
    if (!/^[a-z\d_.-]+$/i.test(service)) return [];
    return [false, true].map((multiMode) => ({
      service,
      multiMode,
      path: '/' + service + (multiMode ? '/TunMulti' : '/Tun'),
    }));
  }
  const split = service.lastIndexOf('/');
  const prefix = service.slice(0, split + 1);
  const names = service.slice(split + 1).split('|');
  if (
    !/^\/(?:[a-z\d_.-]+\/)+$/i.test(prefix) ||
    names.length > 2 ||
    names.some((name) => !/^[a-z\d_.-]+$/i.test(name))
  )
    return [];
  return [names[0], names[1] ?? names[0]].map((name, index) => ({
    service: prefix + name,
    multiMode: index === 1,
    path: prefix + name,
  }));
}

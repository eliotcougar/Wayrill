import { inboundObjects, record, scalarText } from './users/model';
import {
  children,
  exactName,
  formatAddress,
  inherited,
  listeners,
  loopback,
  publicPort,
  sameListener,
  xrayAddress,
  type Address,
  type Listener,
  type NginxDirective,
  type NginxObservation,
} from './nginxConfig';
import { httpPaths, httpProxy, httpVersions } from './nginxHttp';
import { streamRelays, type StreamRelay } from './nginxStream';
import { fallbackFronts, type BoundInbound, type HttpFront } from './xrayFallbackRoutes';
import {
  relaySecurity,
  xrayRelayNetworks,
  xrayTlsAlpn,
  xrayTransport,
  type HttpVersion,
  type RelayNetwork,
  type RelaySecurity,
} from './xrayIngress';

export type { NginxDirective, NginxObservation } from './nginxConfig';

export type NginxRoute = {
  inbound: number;
  address: string;
  port: number;
  serverName: string;
  backend: string;
  network: RelayNetwork;
  security: RelaySecurity;
  alpn?: string[];
  via?: string;
  terminatesTls?: boolean;
  http?: {
    location: string;
    path?: string;
    grpc?: { service: string; multiMode: boolean };
  };
};

export function localOnlyInbound(inbound: Record<string, unknown>) {
  const bind = xrayAddress(inbound);
  return !!bind && ('socket' in bind || loopback(bind.host));
}

function uniqueInbound(inbounds: BoundInbound[], target: Address, network: RelayNetwork) {
  const matches = inbounds.filter(
    ({ bind, networks }) => networks.includes(network) && sameListener(bind, target),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' && value
      ? [value]
      : [];
}

function streamRoutes(inbounds: BoundInbound[], relays: StreamRelay[], sshHost: string) {
  const routes: NginxRoute[] = [];
  const resolve = (relay: StreamRelay, inbound: BoundInbound) => {
    const { incoming } = inbound;
    if (
      !relaySecurity(incoming.security) ||
      !inbound.networks.includes(relay.network) ||
      relay.proxyProtocol !== incoming.proxyProtocol ||
      relay.localHandoff
    )
      return;
    // TLS on the upstream socket is a separate handshake. Its negotiated ALPN
    // cannot be derived for HTTP transports from the public ClientHello alone.
    if (relay.upstreamTls && (incoming.network !== 'raw' || incoming.security !== 'tls')) return;
    if (relay.tls && !relay.upstreamTls && incoming.security !== 'none') return;
    if (relay.upstreamTls && !relay.tls && incoming.security !== 'tls') return;
    if (relay.alpnDispatch && incoming.security === 'reality') return;

    const security = relay.tls ? 'tls' : relay.upstreamTls ? 'none' : incoming.security;
    const tls = record(incoming.stream.tlsSettings);
    const preferred = scalarText(tls.serverName);
    const names =
      security === 'reality'
        ? stringList(record(incoming.stream.realitySettings).serverNames)
        : security === 'none'
          ? ['']
          : relay.tls
            ? relay.names.length
              ? relay.names
              : exactName(sshHost)
                ? [sshHost]
                : []
            : preferred
              ? [preferred]
              : relay.names.length
                ? relay.names
                : [sshHost];
    const allowed = relay.tls ? relay.alpn : xrayTlsAlpn(incoming);
    const choices =
      incoming.network === 'grpc'
        ? ['h2']
        : ['ws', 'httpupgrade'].includes(incoming.network)
          ? ['http/1.1']
          : incoming.network === 'xhttp' && relay.network === 'tcp'
            ? ['h2', 'http/1.1']
            : allowed.length
              ? allowed
              : relay.alpnDispatch
                ? ['h2', 'http/1.1']
                : [''];
    const offered =
      incoming.network === 'masque'
        ? [relay.network === 'tcp' ? 'h2' : 'h3']
        : relay.network === 'udp' || security !== 'tls'
          ? ['']
          : choices.filter((item) => !allowed.length || allowed.includes(item));
    for (const serverName of names) {
      // An IP address is usable as a certificate name, but Go suppresses IP SNI.
      for (const protocol of offered) {
        if (
          relay.tls &&
          protocol === 'h2' &&
          incoming.network !== 'raw' &&
          !relay.alpn.includes('h2')
        )
          continue;
        const bind = relay.target(
          exactName(serverName) ? serverName : '',
          protocol ? [protocol] : [],
        );
        if (
          !bind ||
          !sameListener(inbound.bind, bind) ||
          uniqueInbound(inbounds, bind, relay.network) !== inbound
        )
          continue;
        const alpn = protocol ? [protocol] : security === 'tls' && !relay.tls ? allowed : [];
        routes.push({
          inbound: inbound.index,
          address: sshHost,
          port: relay.port,
          serverName,
          backend: formatAddress(bind),
          network: relay.network,
          security,
          ...(alpn.length ? { alpn } : {}),
          ...(relay.tls || relay.upstreamTls ? { terminatesTls: true } : {}),
        });
        break;
      }
    }
  };
  for (const relay of relays) for (const inbound of inbounds) resolve(relay, inbound);
  return routes;
}

function publicHttpFronts(
  entry: Listener,
  relays: StreamRelay[],
  host: string,
  version: HttpVersion,
): HttpFront[] {
  if (version === 'h3' && entry.family !== 'quic') return [];
  if (version !== 'h3' && entry.family !== 'tcp') return [];
  if (version === 'h2' && !entry.http2) return [];
  const port = publicPort(entry.address);
  const fronts: HttpFront[] =
    port && !entry.proxyProtocol ? [{ port, tls: entry.tls, alpn: version }] : [];
  for (const relay of relays) {
    if (
      relay.network !== (version === 'h3' ? 'udp' : 'tcp') ||
      relay.proxyProtocol !== entry.proxyProtocol ||
      relay.upstreamTls ||
      (relay.tls && entry.tls) ||
      (relay.tls && version === 'h2' && !relay.alpn.includes('h2'))
    )
      continue;
    const target = relay.target(
      entry.tls || relay.tls ? host : '',
      entry.tls || relay.tls ? [version] : [],
    );
    if (target && sameListener(entry.address, target)) {
      fronts.push({
        port: relay.port,
        tls: entry.tls || relay.tls,
        alpn: version,
        via: formatAddress(target),
      });
    }
  }
  return fronts;
}

function httpRoutes(
  config: NginxDirective[],
  inbounds: BoundInbound[],
  relays: StreamRelay[],
  sshHost: string,
) {
  const routes: NginxRoute[] = [];
  for (const context of config.filter(({ name }) => name === 'http')) {
    const servers = children(context, 'server');
    for (const server of servers) {
      if (['on', 'optional'].includes(inherited('ssl_verify_client', server, context)?.[0] ?? ''))
        continue;
      const names = children(server, 'server_name')
        .flatMap(({ args }) => args)
        .filter(exactName);
      if (!names.length && servers.length === 1 && exactName(sshHost)) names.push(sshHost);
      if (!names.length) continue;
      const entries = listeners(context, server);
      for (const location of children(server, 'location')) {
        const proxy = httpProxy(context, location);
        if (!proxy) continue;
        const target = uniqueInbound(inbounds, proxy.bind, 'tcp');
        if (!target) continue;
        const { incoming, index } = target;
        for (const host of names)
          for (const { request, ...path } of httpPaths(
            incoming,
            context,
            server,
            location,
            host,
            proxy,
          )) {
            for (const entry of entries)
              for (const version of httpVersions(incoming.network)) {
                const fronts = publicHttpFronts(entry, relays, host, version);
                if (
                  entry.family === 'tcp' &&
                  (version !== 'h2' || entry.http2) &&
                  (version !== 'http/1.1' ||
                    incoming.network !== 'xhttp' ||
                    incoming.options.mode === 'stream-one')
                ) {
                  fronts.push(...fallbackFronts(inbounds, relays, entry, host, version, request));
                }
                for (const front of fronts) {
                  if (!front.tls && incoming.network === 'xhttp' && version !== 'http/1.1')
                    continue;
                  routes.push({
                    inbound: index,
                    address: host,
                    port: front.port,
                    serverName: host,
                    backend: formatAddress(proxy.bind),
                    network: version === 'h3' ? 'udp' : 'tcp',
                    security: front.tls ? 'tls' : 'none',
                    ...(front.tls ? { alpn: [front.alpn], terminatesTls: true } : {}),
                    ...(front.via ? { via: front.via } : {}),
                    http: path,
                  });
                }
              }
          }
      }
    }
  }
  return routes;
}

export function nginxRoutes(
  observation: NginxObservation | undefined,
  config: Record<string, unknown>,
  sshHost: string,
) {
  if (observation?.state !== 'ready') return [];
  const inbounds: BoundInbound[] = inboundObjects(config).flatMap((raw, index) => {
    const bind = xrayAddress(raw);
    if (!bind) return [];
    const incoming = xrayTransport(raw);
    return [{ index, bind, raw, incoming, networks: xrayRelayNetworks(raw, incoming) }];
  });
  const relays = streamRelays(observation.config);
  const routes = [
    ...streamRoutes(inbounds, relays, sshHost),
    ...httpRoutes(observation.config, inbounds, relays, sshHost),
  ];
  const unique = new Map<string, NginxRoute>();
  for (const route of routes) {
    const key = JSON.stringify(
      route.http
        ? { ...route, alpn: undefined, http: { ...route.http, grpc: route.http.grpc?.service } }
        : route,
    );
    const previous = unique.get(key);
    if (!previous || (route.alpn?.[0] === 'h2' && previous.alpn?.[0] !== 'h2'))
      unique.set(key, route);
  }
  return [...unique.values()];
}

export function nginxCredentialRoute(routes: NginxRoute[], index: number) {
  return routes
    .filter((route) => route.inbound === index)
    .sort(
      (a, b) =>
        Number(b.security !== 'none') - Number(a.security !== 'none') ||
        Number(b.port === 443) - Number(a.port === 443) ||
        Number(a.http?.grpc?.multiMode === true) - Number(b.http?.grpc?.multiMode === true) ||
        Number(b.network === 'tcp') - Number(a.network === 'tcp') ||
        Number(b.alpn?.[0] === 'h2') - Number(a.alpn?.[0] === 'h2'),
    )[0];
}

export function nginxRouteLabel(route: NginxRoute) {
  const target = formatAddress({ host: route.address, port: route.port });
  const protocol = route.alpn?.[0];
  if (route.http) {
    const service = route.http.grpc?.service;
    return (
      (route.security === 'tls' ? 'https://' : 'http://') +
      target +
      (service?.startsWith('/') ? service : (route.http.path ?? route.http.location)) +
      (protocol ? ' · ' + protocol : '')
    );
  }
  return (
    target +
    ' · ' +
    route.network.toUpperCase() +
    (route.serverName ? ' · SNI ' + route.serverName : '')
  );
}

import {
  children,
  exactName,
  inherited,
  listeners,
  mapValue,
  namedMap,
  publicPort,
  setting,
  upstream,
  type Address,
  type NginxDirective,
} from './nginxConfig';
import type { RelayNetwork } from './xrayIngress';

export type StreamRelay = {
  port: number;
  network: RelayNetwork;
  tls: boolean;
  upstreamTls: boolean;
  proxyProtocol: boolean;
  localHandoff: boolean;
  names: string[];
  alpn: string[];
  alpnDispatch: boolean;
  target: (name: string, alpn: readonly string[]) => Address | undefined;
};

export function streamRelays(config: NginxDirective[]) {
  const relays: StreamRelay[] = [];
  for (const context of config.filter(({ name }) => name === 'stream')) {
    const servers = children(context, 'server').map((server) => ({
      server,
      entries: listeners(context, server),
    }));
    for (const { server, entries } of servers) {
      const handoff = setting(server, 'pass');
      const target = handoff ?? setting(server, 'proxy_pass');
      if (!target) continue;
      const map = namedMap(context, target);
      const by = map?.args[0];
      const preRead = inherited('ssl_preread', server, context)?.[0] === 'on';
      const proxyProtocol = ['on', 'v2'].includes(
        inherited('proxy_protocol', server, context)?.[0] ?? '',
      );
      const upstreamTls = inherited('proxy_ssl', server, context)?.[0] === 'on';
      const names = children(server, 'server_name')
        .flatMap(({ args }) => args)
        .filter(exactName);
      const mapNames = by?.endsWith('_server_name')
        ? (map?.children ?? []).map(({ name }) => name).filter(exactName)
        : [];
      const alpn = inherited('ssl_alpn', server, context) ?? [];
      for (const entry of entries) {
        const port = publicPort(entry.address);
        if (!port || entry.family === 'quic' || entry.proxyProtocol) continue;
        if (entry.family === 'udp' && (map || handoff || upstreamTls || proxyProtocol || entry.tls))
          continue;
        if (
          entry.tls &&
          ['on', 'optional'].includes(inherited('ssl_verify_client', server, context)?.[0] ?? '')
        )
          continue;
        const competing = servers.some(
          ({ server: other, entries: otherEntries }) =>
            other !== server &&
            otherEntries.some(
              (item) => publicPort(item.address) === port && item.family === entry.family,
            ),
        );
        const resolve = (host: string, offered: readonly string[]) => {
          if (competing && !(entry.tls || preRead)) return;
          if (competing && !names.some((name) => name.toLowerCase() === host.toLowerCase())) return;
          if (!map) return upstream(context, target);
          switch (by) {
            case '$ssl_preread_server_name':
              return !entry.tls && preRead
                ? upstream(context, mapValue(map, host) ?? '')
                : undefined;
            case '$ssl_preread_alpn_protocols':
              return !entry.tls && preRead
                ? upstream(context, mapValue(map, offered.join(',')) ?? '')
                : undefined;
            case '$ssl_server_name':
              return entry.tls ? upstream(context, mapValue(map, host) ?? '') : undefined;
            case '$ssl_alpn_protocol': {
              const negotiated = alpn.find((protocol) => offered.includes(protocol));
              return entry.tls
                ? upstream(context, mapValue(map, negotiated ?? '') ?? '')
                : undefined;
            }
          }
        };
        relays.push({
          port,
          network: entry.family,
          tls: entry.tls,
          upstreamTls,
          proxyProtocol,
          localHandoff: !!handoff,
          names: [...new Set([...names, ...mapNames])],
          alpn,
          alpnDispatch: by === '$ssl_preread_alpn_protocols' || by === '$ssl_alpn_protocol',
          target: resolve,
        });
      }
    }
  }
  return relays;
}

import {
  children,
  inherited,
  mapValue,
  namedMap,
  setting,
  upstream,
  type NginxDirective,
} from './nginxConfig';
import { grpcMethods, type HttpVersion, type XrayTransport } from './xrayIngress';
import { record, scalarText } from './users/model';

export type HttpPath = {
  location: string;
  request: string;
  path?: string;
  grpc?: { service: string; multiMode: boolean };
};

export function httpProxy(context: NginxDirective, location: NginxDirective) {
  const grpc = setting(location, 'grpc_pass');
  const target = grpc ?? setting(location, 'proxy_pass');
  if (!target || target.includes('$')) return;
  const scheme = /^(https?|grpcs?):\/\//.exec(target);
  if (!scheme && !grpc) return;
  const rest = target.slice(scheme?.[0].length ?? 0);
  const boundary = rest.startsWith('unix:') ? rest.indexOf(':', 5) : rest.indexOf('/');
  const host = boundary < 0 ? rest : rest.slice(0, boundary);
  const uri = boundary < 0 ? '' : rest.slice(boundary + Number(rest.startsWith('unix:')));
  const tls = scheme?.[1] === 'https' || scheme?.[1] === 'grpcs';
  const bind = upstream(context, host, tls ? 443 : 80);
  return bind && { bind, host, tls, uri, grpc: !!grpc };
}

function changesRequest(
  node: NginxDirective,
  upgrade: boolean,
  postOnly: boolean,
  grpcHeader: boolean,
) {
  return node.children?.some(
    ({ name }) =>
      ['if', 'rewrite', 'return', 'try_files', 'auth_request'].includes(name) ||
      (!upgrade && name === 'upgrade_required') ||
      (!postOnly && name === 'post_required') ||
      (!grpcHeader && name === 'grpc_required') ||
      name.startsWith('access_by_lua') ||
      name.startsWith('rewrite_by_lua'),
  );
}

function matchLocation(path: string, locations: NginxDirective[]) {
  const exact = locations.find(({ args }) => args[0] === '=' && args[1] === path);
  if (exact) return exact;
  const prefix = locations
    .filter(({ args }) => args[0] === '^~' || args[0]?.startsWith('/'))
    .filter(({ args }) => path.startsWith(args.at(-1)!))
    .sort((a, b) => b.args.at(-1)!.length - a.args.at(-1)!.length)[0];
  if (prefix?.args[0] !== '^~' && locations.some(({ args }) => args[0]?.startsWith('~'))) return;
  return prefix;
}

function header(
  location: NginxDirective,
  server: NginxDirective,
  context: NginxDirective,
  field: string,
) {
  const rules = [location, server, context]
    .map((scope) => children(scope, 'proxy_set_header'))
    .find((items) => items.length);
  return rules?.find(({ args }) => args[0]?.toLowerCase() === field)?.args[1];
}

function upgradeHeaders(location: NginxDirective, server: NginxDirective, context: NginxDirective) {
  const version = inherited('proxy_http_version', location, server, context)?.[0];
  if (version !== '1.1') return false;
  const upgrade = header(location, server, context, 'upgrade')?.toLowerCase();
  if (upgrade !== '$http_upgrade' && upgrade !== 'websocket') return false;
  const connection = header(location, server, context, 'connection') ?? '';
  const map = namedMap(context, connection);
  const forwarded = map?.args[0] === '$http_upgrade' ? mapValue(map, 'websocket') : connection;
  return (
    forwarded
      ?.toLowerCase()
      .split(/\s*,\s*/)
      .includes('upgrade') === true
  );
}

export function httpPaths(
  transport: XrayTransport,
  context: NginxDirective,
  server: NginxDirective,
  location: NginxDirective,
  hostname: string,
  proxy: NonNullable<ReturnType<typeof httpProxy>>,
): HttpPath[] {
  const { args } = location;
  const locationPath = args.at(-1);
  if (
    !locationPath?.startsWith('/') ||
    ![1, 2].includes(args.length) ||
    (args.length === 2 && !['=', '^~'].includes(args[0]))
  )
    return [];
  const { network, options, security } = transport;
  const upgrade = network === 'ws' || network === 'httpupgrade';
  const streamOne = network === 'xhttp' && options.mode === 'stream-one';
  const postOnly = network === 'grpc' || (streamOne && !record(options.extra).uplinkHTTPMethod);
  const grpcHeader =
    network === 'grpc' || (streamOne && record(options.extra).noGRPCHeader !== true);
  const auth = inherited('auth_basic', location, server, context);
  if (
    transport.proxyProtocol ||
    (proxy.tls ? 'tls' : 'none') !== security ||
    (auth && auth[0] !== 'off') ||
    changesRequest(location, upgrade, postOnly, grpcHeader) ||
    changesRequest(server, upgrade, postOnly, grpcHeader) ||
    children(location, 'location').length
  )
    return [];
  const locations = children(server, 'location');
  if (network === 'grpc') {
    if (!proxy.grpc || proxy.uri) return [];
    return grpcMethods(options)
      .filter(({ path }) => matchLocation(path, locations) === location)
      .map(({ service, multiMode, path }) => ({
        location: locationPath,
        request: path,
        grpc: { service, multiMode },
      }));
  }
  if (!upgrade && network !== 'xhttp') return [];
  if (
    proxy.grpc &&
    (network !== 'xhttp' ||
      !['stream-one', 'stream-up'].includes(scalarText(options.mode)) ||
      record(options.extra).noGRPCHeader === true)
  )
    return [];
  if (upgrade && !upgradeHeaders(location, server, context)) return [];

  const backendPath = scalarText(options.path) || '/';
  const [bare, ...query] = backendPath.split('?');
  const barePath = bare || '/';
  const request = network === 'xhttp' && !barePath.endsWith('/') ? barePath + '/' : barePath;
  if (!request.startsWith('/') || /[\s%#]/.test(request)) return [];
  if (proxy.uri && !request.startsWith(proxy.uri)) return [];
  const clientPath = proxy.uri ? locationPath + request.slice(proxy.uri.length) : request;
  if (matchLocation(clientPath, locations) !== location) return [];
  if (
    network === 'xhttp' &&
    options.mode !== 'stream-one' &&
    (args[0] === '=' ||
      locations.some(
        (other) =>
          other !== location &&
          other.args.at(-1)?.startsWith(clientPath) &&
          other.args.at(-1) !== clientPath,
      ))
  )
    return [];
  const host =
    scalarText(options.host) ||
    scalarText(
      Object.entries(record(options.headers)).find(([name]) => name.toLowerCase() === 'host')?.[1],
    );
  if (host && !proxy.grpc) {
    const forwarded = header(location, server, context, 'host') ?? '$proxy_host';
    const actual =
      forwarded === '$server_name'
        ? (children(server, 'server_name')[0]?.args[0] ?? '')
        : ['$host', '$http_host'].includes(forwarded)
          ? hostname
          : forwarded === '$proxy_host'
            ? proxy.host
            : forwarded;
    if (actual.toLowerCase() !== host.toLowerCase()) return [];
  }
  if (host && proxy.grpc) {
    const rules = [location, server, context]
      .map((scope) => children(scope, 'grpc_set_header'))
      .find((items) => items.length);
    const value = rules?.find(({ args }) => args[0]?.toLowerCase() === 'host')?.args[1];
    const actual = value === '$host' || value === '$http_host' ? hostname : (value ?? proxy.host);
    if (actual.toLowerCase() !== host.toLowerCase()) return [];
  }
  return [
    {
      location: locationPath,
      request: clientPath,
      path: proxy.uri ? [clientPath, ...query].join('?') : backendPath,
    },
  ];
}

export function httpVersions(network: string): HttpVersion[] {
  if (network === 'grpc') return ['h2'];
  if (network === 'xhttp') return ['h2', 'h3', 'http/1.1'];
  return ['http/1.1'];
}

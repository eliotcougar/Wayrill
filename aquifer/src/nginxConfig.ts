import { scalarText } from './users/model';

export type NginxDirective = {
  name: string;
  args: string[];
  children?: NginxDirective[];
};
export type NginxObservation =
  { state: 'missing' | 'unavailable' } | { state: 'ready'; config: NginxDirective[] };

export type Address = { host: string; port: number } | { socket: string };
export type Listener = {
  address: Address;
  family: 'tcp' | 'udp' | 'quic';
  tls: boolean;
  http2: boolean;
  proxyProtocol: boolean;
};

export const children = (node: NginxDirective, name: string) =>
  node.children?.filter((item) => item.name === name) ?? [];
export const setting = (node: NginxDirective, name: string) => children(node, name)[0]?.args[0];
export const inherited = (name: string, ...scope: NginxDirective[]) =>
  scope.map((node) => children(node, name)[0]).find(Boolean)?.args;
export const loopback = (host: string) =>
  host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
export const exactName = (value: string) =>
  /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(value) &&
  !loopback(value) &&
  !/^\d+(?:\.\d+)+$/.test(value);

export function address(value: string, defaultPort = 0): Address | undefined {
  if (value.startsWith('unix:') && value.length > 5) return { socket: value.slice(5) };
  const match = /^(?:\[([\da-f:]+)\]|([^:]+))(?::(\d+))?$/i.exec(value);
  if (!match) return;
  const host = (match[1] ?? match[2]).toLowerCase();
  const port = Number(match[3] ?? defaultPort);
  if (port < 1 || port > 65535) return;
  return { host, port };
}

export function xrayAddress(inbound: Record<string, unknown>) {
  const host = scalarText(inbound.listen) || '0.0.0.0';
  if (host.startsWith('/') || host.startsWith('@')) return { socket: host.replace(/,[0-7]+$/, '') };
  const port = Number(scalarText(inbound.port));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  return { host: host.replace(/^\[|\]$/g, '').toLowerCase(), port };
}

export function fallbackAddress(value: unknown) {
  const dest = scalarText(value);
  if (dest.startsWith('/') || dest.startsWith('@')) return { socket: dest };
  return address(/^\d+$/.test(dest) ? '127.0.0.1:' + dest : dest);
}

export function formatAddress(value: Address) {
  if ('socket' in value) return 'unix:' + value.socket;
  const host = value.host.replace(/^\[|\]$/g, '');
  return (host.includes(':') ? '[' + host + ']' : host) + ':' + value.port;
}

export function sameListener(bind: Address, target: Address) {
  if ('socket' in bind || 'socket' in target)
    return 'socket' in bind && 'socket' in target && bind.socket === target.socket;
  if (bind.port !== target.port) return false;
  if (bind.host === target.host) return true;
  if (!loopback(target.host)) return false;
  if (bind.host === '*') return true;
  if (target.host === 'localhost') return ['127.0.0.1', '::1', '0.0.0.0', '::'].includes(bind.host);
  if (bind.host === 'localhost') return target.host === '::1' || target.host === '127.0.0.1';
  return bind.host === (target.host.includes(':') ? '::' : '0.0.0.0');
}

export const publicPort = (value: Address) =>
  'host' in value && !loopback(value.host) ? value.port : undefined;

export function listeners(context: NginxDirective, server: NginxDirective): Listener[] {
  const rows = children(server, 'listen').map(({ args }) => args);
  const http = context.name === 'http';
  if (!rows.length && http) rows.push(['80']);
  return rows.flatMap(([value, ...options]) => {
    if (!value) return [];
    const parsed = /^\d+$/.test(value) ? address('*:' + value) : address(value);
    if (!parsed) return [];
    const h2 = inherited('http2', server, context)?.[0];
    const quic = options.includes('quic');
    if (quic && inherited('http3', server, context)?.[0] === 'off') return [];
    return [
      {
        address: parsed,
        family: quic ? 'quic' : options.includes('udp') ? 'udp' : 'tcp',
        tls: quic || options.includes('ssl') || (http && setting(server, 'ssl') === 'on'),
        proxyProtocol: options.includes('proxy_protocol'),
        http2: h2 === 'on' || (h2 === undefined && options.includes('http2')),
      },
    ];
  });
}

export function upstream(context: NginxDirective, value: string, port?: number) {
  if (!value || value.includes('$')) return;
  const group = children(context, 'upstream').find((item) => item.args[0] === value);
  if (group) {
    const members = children(group, 'server').filter(({ args }) => !args.includes('down'));
    const targets = new Set(members.map(({ args }) => args[0]));
    if (targets.size !== 1) return;
    value = members[0].args[0];
  }
  const target = address(value, port);
  if (target && 'host' in target && !/^[\da-f:.]+$|^localhost$/i.test(target.host)) return;
  return target;
}

export function mapValue(map: NginxDirective, key: string) {
  const entries = map.children ?? [];
  const defaultValue = entries.find(({ name }) => name === 'default')?.args[0];
  if (
    entries.some(
      ({ name, args }) =>
        args.length !== 1 ||
        name === 'include' ||
        (name.startsWith('~') &&
          (map.args[0] !== '$ssl_preread_alpn_protocols' ||
            !/^~\\b(?:h2|http\/1\.1)\\b$/.test(name))),
    )
  )
    return;
  const exact = entries.find(
    ({ name }) => name !== 'default' && name.toLowerCase() === key.toLowerCase(),
  );
  const token = entries.find(
    ({ name }) =>
      name.startsWith('~\\b') && key.split(',').includes(name.slice(3, -2).replace('\\.', '.')),
  );
  return (exact ?? token)?.args[0] ?? defaultValue;
}

export function namedMap(context: NginxDirective, variable: string) {
  const name = variable.replace(/^\$\{(\w+)\}$/, '$$$1');
  return children(context, 'map').find(({ args }) => args[1] === name);
}

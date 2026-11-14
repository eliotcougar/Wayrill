import { xrayOutbound } from '../profiles/import';
import { serverPublicKey } from '../serverKeys';
import {
  inboundUserProtocol,
  record,
  scalarText,
  setProblem,
  settingsOf,
  type UserSet,
} from './model';

const transportOptions: Record<string, readonly string[]> = {
  raw: [],
  ws: ['path', 'host', 'headers'],
  httpupgrade: ['path', 'host', 'headers'],
  grpc: ['serviceName', 'authority', 'multiMode'],
  xhttp: ['path', 'host', 'mode'],
  kcp: ['seed', 'header'],
  hysteria: ['version'],
  masque: ['host', 'path'],
};

function fields(value: unknown, keys: readonly string[]) {
  const object = record(value);
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(object, key)).map((key) => [key, object[key]]),
  );
}

function endpoint(host: string, port: number) {
  const address = host.trim().replace(/^\[|\]$/g, '');
  if (
    !address ||
    /[\s/?#@\\%]/.test(address) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Enter the public hostname or IP address and port.');
  const url = new URL(`https://${address.includes(':') ? `[${address}]` : address}`);
  if (url.port || url.pathname !== '/') throw new Error('Enter the port separately from the host.');
  return url.hostname.replace(/^\[|\]$/g, '');
}

export async function generatePoolConnections(
  set: UserSet,
  inbound: Record<string, unknown>,
  host: string,
  port: number,
  serverName: string,
) {
  if (inboundUserProtocol(inbound) !== set.protocol)
    throw new Error('Choose an inbound that uses this user set.');
  const problem = setProblem(set);
  if (problem) throw new Error(problem);
  const address = endpoint(host, port);
  const source = record(inbound.streamSettings);
  const inboundSettings = settingsOf(inbound);
  const network = (scalarText(source.network) || 'raw').toLowerCase().replace(/^tcp$/, 'raw');
  const security = (scalarText(source.security) || 'none').toLowerCase();
  if (!Object.hasOwn(transportOptions, network) || !['none', 'tls', 'reality'].includes(security))
    throw new Error('This inbound transport or security mode requires manual client settings.');
  const transportKey = `${network}Settings`;
  const transport = record(
    source[transportKey] ?? (network === 'raw' ? source.tcpSettings : undefined),
  );
  const transportFields = fields(transport, transportOptions[network]);
  if (network === 'raw') {
    const header = record(transport.header);
    if (header.type === 'http')
      transportFields.header = { type: 'http', ...fields(header, ['request']) };
  }
  if (network === 'xhttp' && Object.keys(record(transport.extra)).length)
    throw new Error('An XHTTP inbound with custom extra settings requires manual client settings.');
  if (Object.keys(record(source.finalmask ?? source.finalMask)).length)
    throw new Error('This inbound uses a custom FinalMask that requires manual client settings.');
  const streamSettings: Record<string, unknown> = { network, security };
  if (Object.keys(transportFields).length) streamSettings[transportKey] = transportFields;
  if (security === 'tls') {
    const tls = record(source.tlsSettings);
    streamSettings.tlsSettings = {
      ...fields(tls, ['alpn']),
      serverName: serverName.trim() || scalarText(tls.serverName) || address,
    };
  } else if (security === 'reality') {
    const reality = record(source.realitySettings);
    if (reality.mldsa65Seed)
      throw new Error(
        'This REALITY inbound requires a separately provisioned ML-DSA verification key.',
      );
    const names: unknown[] = Array.isArray(reality.serverNames) ? reality.serverNames : [];
    const name = serverName.trim() || names[0];
    const ids: unknown[] = Array.isArray(reality.shortIds) ? reality.shortIds : [];
    if (
      typeof reality.privateKey !== 'string' ||
      typeof name !== 'string' ||
      !names.includes(name) ||
      typeof ids[0] !== 'string'
    )
      throw new Error(
        'REALITY requires a private key, an allowed server name, and a short ID on the inbound.',
      );
    streamSettings.realitySettings = {
      serverName: name,
      fingerprint: 'chrome',
      password: await serverPublicKey(reality.privateKey, false),
      shortId: ids[0],
    };
  }
  if (
    set.protocol === 'vless' &&
    inboundSettings.decryption &&
    inboundSettings.decryption !== 'none'
  )
    throw new Error(
      'This VLESS inbound requires a separately provisioned client encryption string.',
    );

  const active = set.users.filter((user) => user.enabled);
  if (!active.length) throw new Error('This set has no enabled users.');
  const users = active.map((user) => {
    const account = user.account;
    const stream = { ...streamSettings };
    const settings: Record<string, unknown> = { address, port };
    let protocol = scalarText(inbound.protocol).toLowerCase();
    switch (set.protocol) {
      case 'password':
        protocol = protocol === 'http' ? 'http' : 'socks';
        Object.assign(settings, fields(account, ['user', 'pass']));
        break;
      case 'vless':
        Object.assign(settings, fields(account, ['id', 'flow']), { encryption: 'none' });
        break;
      case 'vmess':
        Object.assign(settings, fields(account, ['id']), { security: 'auto' });
        break;
      case 'trojan':
        Object.assign(settings, fields(account, ['password']));
        break;
      case 'shadowsocks':
        Object.assign(settings, fields(account, ['method', 'password']));
        break;
      case 'ss2022-128':
      case 'ss2022-256':
        if (typeof inboundSettings.password !== 'string' || !inboundSettings.password)
          throw new Error('Set the Shadowsocks 2022 server key on the inbound first.');
        Object.assign(settings, {
          method: inboundSettings.method,
          password: `${inboundSettings.password}:${scalarText(account.password)}`,
        });
        break;
      case 'hysteria':
        if (network !== 'hysteria' || security !== 'tls')
          throw new Error('Hysteria 2 requires Hysteria transport and TLS.');
        settings.version = 2;
        stream.hysteriaSettings = { ...transportFields, version: 2, auth: account.auth };
        break;
      case 'masque':
        if (network !== 'masque' || security !== 'tls')
          throw new Error('MASQUE requires MASQUE transport and TLS.');
        stream.masqueSettings = { ...transportFields, user: account.email, pass: account.pass };
        break;
    }
    const outbound = { tag: 'aquifer-server', protocol, settings, streamSettings: stream };
    xrayOutbound(outbound);
    return { id: `${set.id}:${user.id}`, name: user.name, outbound };
  });
  return { format: 'wayrill.pool.users', version: 1, users };
}

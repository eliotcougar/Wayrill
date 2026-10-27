import { jsonRecord, parseXrayJson, jsonText, jsonArray, parseJson } from '../graph/xrayJson';
const record = (v: unknown): Record<string, unknown> => (jsonRecord(v) ? v : {});
const list = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export function protocolLink(
  text: string,
  decode: (s: string) => string,
): { config: Record<string, unknown>; name?: string } {
  let scheme = text.slice(0, text.indexOf(':')).toLowerCase(),
    source = text;
  if (scheme === 'vmess') {
    const value = parseXrayJson(decode(text.slice(text.indexOf('://') + 3).split('#')[0])),
      v = record(value);
    const allowed = [
      'v',
      'ps',
      'add',
      'port',
      'id',
      'aid',
      'scy',
      'net',
      'type',
      'host',
      'path',
      'tls',
      'sni',
      'alpn',
      'fp',
      'insecure',
    ];
    if (Object.keys(v).some((k) => !allowed.includes(k)))
      throw new Error('VMess contains unmapped link fields. Original retained.');
    if (v.aid !== undefined && Number(v.aid) !== 0)
      throw new Error('Legacy VMess alterId is unsupported by the pinned core. Original retained.');
    if (!['0', 'false', ''].includes(jsonText(v.insecure ?? '0')))
      throw new Error('The pinned core removed insecure TLS. Original retained.');
    const network = jsonText(v.net ?? 'tcp'),
      stream: Record<string, unknown> = {
        network: network === 'tcp' ? 'raw' : network,
        security: jsonText(v.tls || 'none'),
      };
    if (!['raw', 'ws', 'httpupgrade', 'grpc', 'xhttp', 'kcp'].includes(String(stream.network)))
      throw new Error('VMess link transport is not mapped. Original retained.');
    if (['ws', 'httpupgrade', 'xhttp'].includes(String(stream.network)))
      stream[`${jsonText(stream.network)}Settings`] = {
        host: v.host ?? '',
        path: v.path ?? '',
        ...(stream.network === 'xhttp' && v.type ? { mode: v.type } : {}),
      };
    else if (stream.network === 'grpc')
      stream.grpcSettings = {
        authority: v.host ?? '',
        serviceName: v.path ?? '',
        multiMode: v.type === 'multi',
      };
    else if (stream.network === 'kcp')
      stream.kcpSettings = {
        seed: v.path ?? '',
        ...(v.type && v.type !== 'none' ? { header: { type: v.type } } : {}),
      };
    else if (v.type === 'http')
      stream.rawSettings = {
        header: {
          type: 'http',
          request: { path: [v.path || '/'], headers: { Host: list(jsonText(v.host ?? '')) } },
        },
      };
    if (stream.security === 'tls')
      stream.tlsSettings = {
        ...(v.sni ? { serverName: v.sni } : {}),
        ...(v.alpn ? { alpn: list(jsonText(v.alpn)) } : {}),
        ...(v.fp ? { fingerprint: v.fp } : {}),
      };
    return {
      name: jsonText(v.ps ?? ''),
      config: {
        protocol: 'vmess',
        settings: {
          address: jsonText(v.add ?? ''),
          port: Number(v.port),
          id: jsonText(v.id ?? ''),
          security: jsonText(v.scy || 'auto'),
        },
        streamSettings: stream,
      },
    };
  }
  if (['ss', 'socks', 'socks5'].includes(scheme)) {
    const body = text.slice(text.indexOf('://') + 3),
      main = body.split(/[?#]/)[0];
    // A plain SOCKS host (including IPv6) needs no credentials. Only opaque
    // authorities use the legacy whole-authority Base64 representation.
    if (!main.includes('@') && !main.includes(':') && !main.startsWith('['))
      source = `${scheme}://${decode(main)}${body.slice(main.length)}`;
  }
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    throw new Error('Malformed protocol link. Original retained.');
  }
  const q = u.searchParams,
    common = [
      'type',
      'security',
      'sni',
      'peer',
      'fp',
      'alpn',
      'host',
      'path',
      'serviceName',
      'authority',
      'mode',
      'headerType',
      'seed',
      'pbk',
      'sid',
      'spx',
      'pqv',
      'ech',
      'vcn',
      'pcs',
      'fm',
      'allowInsecure',
      'insecure',
      'pinSHA256',
    ];
  const allowed =
    scheme === 'wireguard'
      ? ['publickey', 'presharedkey', 'reserved', 'address', 'mtu', 'dns', 'keepalive', 'fm']
      : common.concat(
          ['hysteria2', 'hy2', 'hysteria'].includes(scheme)
            ? ['obfs', 'obfs-password', 'mport', 'hop-interval', 'up', 'down']
            : [],
        );
  for (const key of q.keys())
    if (!allowed.includes(key))
      throw new Error(`Unmapped ${scheme} parameter ${key}. Original retained.`);
  for (const key of new Set(q.keys()))
    if (q.getAll(key).length > 1)
      throw new Error(`Repeated ${key} parameters are ambiguous. Original retained.`);
  if (
    ['allowInsecure', 'insecure'].some((k) => q.has(k) && !['0', 'false', ''].includes(q.get(k)!))
  )
    throw new Error('The pinned core removed insecure TLS. Original retained.');
  if (u.pathname && !['', '/'].includes(u.pathname))
    throw new Error(
      'A link URL path is not mapped; use the path query parameter. Original retained.',
    );
  const server = u.hostname.replace(/^\[|\]$/g, ''),
    port = Number(
      u.port ||
        (['hysteria2', 'hy2', 'trojan', 'https', 'masque'].includes(scheme)
          ? 443
          : scheme === 'http'
            ? 80
            : 0),
    );
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('A server and valid port are required.');
  let user = decodeURIComponent(u.username),
    password = decodeURIComponent(u.password);
  if (['ss', 'socks', 'socks5'].includes(scheme) && (user || password)) {
    // Decode the complete userinfo before separating it, as in v2rayN. URL
    // getters lose a literal trailing colon and keep an encoded colon in username.
    const authority = source.slice(source.indexOf('://') + 3).split(/[/?#]/)[0],
      info = decodeURIComponent(authority.slice(0, authority.lastIndexOf('@'))),
      auth = info.includes(':') ? info : decode(info),
      colon = auth.indexOf(':');
    if (colon < 0) throw new Error('Credentials need a username/method and password.');
    user = auth.slice(0, colon);
    password = auth.slice(colon + 1);
  }
  scheme =
    (
      {
        ss: 'shadowsocks',
        socks5: 'socks',
        hysteria2: 'hysteria',
        hy2: 'hysteria',
        https: 'http',
      } as Record<string, string>
    )[scheme] ?? scheme;
  if (
    !['shadowsocks', 'socks', 'http', 'trojan', 'wireguard', 'hysteria', 'masque'].includes(scheme)
  )
    throw new Error(
      'This share-link protocol is not mapped by the pinned core. Original retained.',
    );
  const settings: Record<string, unknown> =
    scheme === 'wireguard'
      ? {
          secretKey: decodeURIComponent(u.username + (u.password ? ':' + u.password : '')),
          noKernelTun: true,
          peers: [
            {
              publicKey: q.get('publickey') ?? '',
              endpoint: `${server.includes(':') ? '[' + server + ']' : server}:${port}`,
              allowedIPs: ['0.0.0.0/0', '::/0'],
              ...(q.get('presharedkey') ? { preSharedKey: q.get('presharedkey') } : {}),
              ...(q.get('keepalive') ? { keepAlive: Number(q.get('keepalive')) } : {}),
            },
          ],
          ...(q.get('address') ? { address: list(q.get('address')!) } : {}),
          ...(q.get('mtu') ? { mtu: Number(q.get('mtu')) } : {}),
          ...(q.get('dns') ? { remoteDNS: list(q.get('dns')!) } : {}),
          ...(q.get('reserved') ? { reserved: parseJson(`[${q.get('reserved')}]`) } : {}),
        }
      : {
          address: server,
          port,
          ...(scheme === 'shadowsocks'
            ? { method: user, password }
            : scheme === 'trojan'
              ? { password: decodeURIComponent(u.username + (u.password ? ':' + u.password : '')) }
              : ['http', 'socks'].includes(scheme) && user
                ? { user, pass: password }
                : scheme === 'hysteria'
                  ? { version: 2 }
                  : {}),
        };
  const network = q.get('type') ?? (['hysteria', 'masque'].includes(scheme) ? scheme : 'raw'),
    security =
      q.get('security') ??
      (['trojan', 'hysteria', 'masque'].includes(scheme) || u.protocol === 'https:'
        ? 'tls'
        : 'none');
  if (
    !['raw', 'tcp', 'ws', 'httpupgrade', 'grpc', 'xhttp', 'kcp', 'hysteria', 'masque'].includes(
      network,
    )
  )
    throw new Error('Unsupported link transport. Original retained.');
  if (!['none', 'tls', 'reality'].includes(security))
    throw new Error('Unsupported link security. Original retained.');
  const stream: Record<string, unknown> = {
    network: network === 'tcp' ? 'raw' : network,
    security,
  };
  const tls: Record<string, unknown> = {
    ...(q.get('sni') || q.get('peer') ? { serverName: q.get('sni') ?? q.get('peer') } : {}),
    ...(q.get('alpn') ? { alpn: list(q.get('alpn')!) } : {}),
    ...(q.get('fp') ? { fingerprint: q.get('fp') } : {}),
    ...(q.get('pinSHA256') || q.get('pcs')
      ? { pinnedPeerCertSha256: (q.get('pinSHA256') ?? q.get('pcs'))!.replaceAll(':', '') }
      : {}),
    ...(q.get('vcn') ? { verifyPeerCertByName: q.get('vcn') } : {}),
    ...(q.get('ech') ? { echConfigList: q.get('ech') } : {}),
  };
  if (security === 'tls') stream.tlsSettings = tls;
  if (security === 'reality')
    stream.realitySettings = {
      serverName: q.get('sni') ?? '',
      fingerprint: q.get('fp') ?? 'chrome',
      password: q.get('pbk') ?? '',
      shortId: q.get('sid') ?? '',
      spiderX: q.get('spx') ?? '',
      ...(q.get('pqv') ? { mldsa65Verify: q.get('pqv') } : {}),
    };
  if (['ws', 'httpupgrade', 'xhttp'].includes(String(stream.network)))
    stream[`${jsonText(stream.network)}Settings`] = {
      host: q.get('host') ?? '',
      path: q.get('path') ?? '/',
      ...(stream.network === 'xhttp' ? { mode: q.get('mode') ?? 'auto' } : {}),
    };
  if (stream.network === 'grpc')
    stream.grpcSettings = {
      serviceName: q.get('serviceName') ?? '',
      authority: q.get('authority') ?? q.get('host') ?? '',
      multiMode: q.get('mode') === 'multi',
    };
  if (stream.network === 'raw' && q.get('headerType') === 'http')
    stream.rawSettings = {
      header: {
        type: 'http',
        request: { path: [q.get('path') ?? '/'], headers: { Host: list(q.get('host') ?? '') } },
      },
    };
  if (stream.network === 'kcp')
    stream.kcpSettings = {
      ...(q.get('seed') ? { seed: q.get('seed') } : {}),
      ...(q.get('headerType') && q.get('headerType') !== 'none'
        ? { header: { type: q.get('headerType') } }
        : {}),
    };
  if (
    stream.network === 'raw' &&
    q.get('headerType') &&
    !['none', 'http'].includes(q.get('headerType')!)
  )
    throw new Error('Unmapped RAW header type. Original retained.');
  if (
    stream.network === 'raw' &&
    q.get('headerType') !== 'http' &&
    (q.get('host') || q.get('path'))
  )
    throw new Error('RAW host/path requires the HTTP header type. Original retained.');
  if (stream.network === 'hysteria')
    stream.hysteriaSettings = {
      version: 2,
      auth: decodeURIComponent(u.username + (u.password ? ':' + u.password : '')),
    };
  if (stream.network === 'masque')
    stream.masqueSettings = {
      user,
      pass: password,
      ...(q.get('host') ? { host: q.get('host') } : {}),
      ...(q.get('path') ? { path: q.get('path') } : {}),
    };
  const parsedMask = q.get('fm') ? parseXrayJson(q.get('fm')!) : {};
  if (!jsonRecord(parsedMask))
    throw new Error('FinalMask must be a JSON object. Original retained.');
  let mask: Record<string, unknown> = parsedMask;
  if (q.has('obfs-password') && !q.has('obfs'))
    throw new Error('Obfuscation password requires an obfuscation mode. Original retained.');
  if (q.has('hop-interval') && !q.has('mport'))
    throw new Error('Hop interval requires remote ports. Original retained.');
  if (q.get('obfs')) {
    if (q.get('obfs') !== 'salamander')
      throw new Error('Unmapped UDP obfuscation. Original retained.');
    mask = {
      ...mask,
      udp: [
        ...(jsonArray(mask.udp) ? mask.udp : []),
        { type: 'salamander', settings: { password: q.get('obfs-password') ?? '' } },
      ],
    };
  }
  if (q.get('mport'))
    mask = {
      ...mask,
      udp: [
        ...(jsonArray(mask.udp) ? mask.udp : []),
        {
          type: 'udphop',
          settings: {
            mode: 'intervalRemote',
            interval: q.get('hop-interval') ?? 30,
            remotePorts: q.get('mport')!.replaceAll(':', '-'),
          },
        },
      ],
    };
  if (q.get('up') || q.get('down'))
    mask = {
      ...mask,
      quicParams: {
        ...record(mask.quicParams),
        congestion: 'brutal',
        ...(q.get('up') ? { brutalUp: q.get('up') } : {}),
        ...(q.get('down') ? { brutalDown: q.get('down') } : {}),
      },
    };
  if (Object.keys(mask).length) stream.finalmask = mask;
  // Never silently accept a transport parameter on a different transport.
  for (const [key, networks] of Object.entries({
    path: ['raw', 'ws', 'httpupgrade', 'xhttp', 'masque'],
    host: ['raw', 'ws', 'httpupgrade', 'xhttp', 'grpc', 'masque'],
    serviceName: ['grpc'],
    authority: ['grpc'],
    mode: ['grpc', 'xhttp'],
    headerType: ['raw', 'kcp'],
    seed: ['kcp'],
    obfs: ['hysteria'],
    mport: ['hysteria'],
    up: ['hysteria'],
    down: ['hysteria'],
  }))
    if (q.get(key) && !networks.includes(String(stream.network)))
      throw new Error(`${key} is not mapped for this transport. Original retained.`);
  if (security !== 'reality' && ['pbk', 'sid', 'spx', 'pqv'].some((k) => q.has(k)))
    throw new Error('REALITY parameters require REALITY security. Original retained.');
  if (
    security === 'none' &&
    ['sni', 'peer', 'fp', 'alpn', 'ech', 'vcn', 'pcs', 'pinSHA256'].some((k) => q.has(k))
  )
    throw new Error('TLS parameters require TLS or REALITY security. Original retained.');
  if (
    security === 'reality' &&
    ['peer', 'alpn', 'ech', 'vcn', 'pcs', 'pinSHA256'].some((k) => q.has(k))
  )
    throw new Error('These TLS parameters are not mapped to REALITY. Original retained.');
  return {
    name: decodeURIComponent(u.hash.slice(1)),
    config: {
      protocol: scheme,
      settings,
      ...(scheme === 'wireguard'
        ? Object.keys(mask).length
          ? { streamSettings: { finalmask: mask } }
          : {}
        : { streamSettings: stream }),
    },
  };
}

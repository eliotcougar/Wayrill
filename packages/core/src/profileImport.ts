import { jsonArray, parseJson } from './xrayJson';
import type { SettingValue } from './settings';

const record = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !jsonArray(x) ? (x as Record<string, unknown>) : {};
const str = (x: unknown) => (typeof x === 'string' ? x : '');
const json = (x: unknown) => JSON.stringify(x);
const list = (x: unknown) => (jsonArray(x) ? x.join(', ') : str(x));
const keys = (x: Record<string, unknown>, excluded: string[]) =>
  Object.fromEntries(Object.entries(x).filter(([key]) => !excluded.includes(key)));

export interface BasicOutboundProfile {
  kind: 'vless-outbound' | 'socks-outbound' | 'direct-outbound' | 'block-outbound';
  settings: Record<string, SettingValue>;
}

export function vlessLinkSettings(text: string): Record<string, SettingValue> {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error('Malformed VLESS link.');
  }
  if (u.protocol !== 'vless:' || u.password || !u.hostname || !u.port)
    throw new Error('VLESS needs a user ID, server address and explicit port.');
  const q = u.searchParams;
  const known = [
    'encryption',
    'flow',
    'security',
    'type',
    'sni',
    'fp',
    'pbk',
    'sid',
    'spx',
    'pqv',
    'alpn',
    'ech',
    'vcn',
    'pcs',
    'fm',
    'host',
    'path',
    'headerType',
    'mode',
    'extra',
    'serviceName',
    'authority',
    'allowInsecure',
    'insecure',
    'mtu',
  ];
  for (const key of q.keys()) {
    if (!known.includes(key))
      throw new Error(
        `Unsupported VLESS parameter: ${key.slice(0, 64)}. Original retained in stash.`,
      );
    if (q.getAll(key).length > 1) throw new Error(`Repeated VLESS parameter: ${key.slice(0, 64)}.`);
  }
  if (
    ['allowInsecure', 'insecure'].some((k) => q.has(k) && !['0', 'false', ''].includes(q.get(k)!))
  )
    throw new Error(
      'Insecure TLS cannot be represented by the pinned Xray core. Original retained.',
    );
  const network = q.get('type') || 'raw';
  const s: Record<string, SettingValue> = {
    address: new URL(`https://${decodeURIComponent(u.hostname)}`).hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port),
    id: decodeURIComponent(u.username),
    encryption: q.get('encryption') || 'none',
    flow: q.get('flow') || '',
    network: network === 'tcp' ? 'raw' : network === 'splithttp' ? 'xhttp' : network,
    security: q.get('security') || 'none',
  };
  for (const [param, setting] of Object.entries({
    sni: 'serverName',
    fp: 'fingerprint',
    pbk: 'realityPassword',
    sid: 'shortId',
    spx: 'spiderX',
    pqv: 'mldsa65Verify',
    alpn: 'alpn',
    ech: 'echConfigList',
    vcn: 'verifyPeerCertByName',
    pcs: 'pinnedPeerCertSha256',
  }))
    if (q.has(param)) s[setting] = q.get(param)!;
  if (s.network === 'raw') {
    s.rawHeaderType = q.get('headerType') || 'none';
    if (q.has('host')) s.rawHost = q.get('host')!;
    if (q.has('path')) s.rawPath = q.get('path')!;
  }
  if (['ws', 'httpupgrade', 'xhttp'].includes(String(s.network))) {
    if (q.has('host')) s.host = q.get('host')!;
    if (q.has('path')) s.path = q.get('path')!;
  }
  if (s.network === 'xhttp') {
    if (q.has('mode')) s.xhttpMode = q.get('mode')!;
    if (q.has('extra')) s.xhttpExtra = json(parseJson(q.get('extra')!));
  }
  if (s.network === 'grpc') {
    if (q.has('serviceName')) s.grpcServiceName = q.get('serviceName')!;
    if (q.has('authority')) s.grpcAuthority = q.get('authority')!;
    if (q.has('mode')) {
      if (!['gun', 'multi'].includes(q.get('mode')!)) throw new Error('Unsupported gRPC mode.');
      s.grpcMultiMode = q.get('mode') === 'multi';
    }
  }
  if (s.network === 'kcp') {
    if (q.has('mtu')) s.kcpMtu = Number(q.get('mtu'));
    if (q.has('headerType') && q.get('headerType') !== 'none')
      throw new Error('Legacy mKCP camouflage requires a native FinalMask configuration.');
  }
  if (q.has('fm')) s.finalmask = json(parseJson(q.get('fm')!));
  // Avoid reporting a link as ready while discarding a meaningful transport option.
  for (const [param, transports] of Object.entries({
    extra: ['xhttp'],
    serviceName: ['grpc'],
    authority: ['grpc'],
    mtu: ['kcp'],
    mode: ['grpc', 'xhttp'],
    host: ['raw', 'ws', 'httpupgrade', 'xhttp'],
    path: ['raw', 'ws', 'httpupgrade', 'xhttp'],
    headerType: ['raw', 'kcp'],
  }))
    if (q.get(param) && !transports.includes(String(s.network)))
      throw new Error(`Parameter ${param} is not mapped for this transport.`);
  return s;
}
// Parse portable settings only; each app supplies its own defaults and validation.
export function basicOutboundSettings(raw: unknown, canonical: string): BasicOutboundProfile {
  const o = record(raw),
    settings = record(o.settings),
    stream = record(o.streamSettings),
    s: Record<string, SettingValue> = {};
  const kind: BasicOutboundProfile['kind'] =
    canonical === 'vless'
      ? 'vless-outbound'
      : canonical === 'socks'
        ? 'socks-outbound'
        : canonical === 'freedom'
          ? 'direct-outbound'
          : canonical === 'blackhole'
            ? 'block-outbound'
            : (() => {
                throw new Error('This protocol has no executable Wayrill node yet.');
              })();
  const unexpected = Object.keys(o).filter(
    (k) =>
      ![
        'tag',
        'protocol',
        'settings',
        'streamSettings',
        'sendThrough',
        'targetStrategy',
        'mux',
      ].includes(k),
  );
  if (unexpected.length) throw new Error(`Unmapped outbound fields: ${unexpected.join(', ')}.`);
  if (o.tag) s.tag = str(o.tag);
  if (o.sendThrough) s.sendThrough = str(o.sendThrough);
  const socket = record(stream.sockopt);
  for (const key of [
    'domainStrategy',
    'interface',
    'dialerProxy',
    'tcpKeepAliveIdle',
    'tcpKeepAliveInterval',
    'tcpUserTimeout',
  ])
    if (key in socket) s[key] = socket[key] as SettingValue;
  if ('tcpFastOpen' in socket) s.tcpFastOpen = socket.tcpFastOpen ? 'enabled' : 'disabled';
  const socketExtra = keys(socket, [
    'domainStrategy',
    'interface',
    'dialerProxy',
    'tcpKeepAliveIdle',
    'tcpKeepAliveInterval',
    'tcpUserTimeout',
    'tcpFastOpen',
  ]);
  if (Object.keys(socketExtra).length) s.sockoptExtra = json(socketExtra);
  if (kind === 'block-outbound') {
    if (
      Object.keys(stream).length ||
      o.sendThrough ||
      o.mux ||
      Object.keys(keys(settings, ['response'])).length
    )
      throw new Error('Unmapped Block outbound options.');
    const response = record(settings.response);
    s.response = str(response.type) || 'none';
    if (response.customResponseData) s.customResponseData = str(response.customResponseData);
  } else if (kind === 'direct-outbound') {
    if (Object.keys(keys(stream, ['sockopt'])).length || o.mux || o.targetStrategy)
      throw new Error('Unmapped Direct transport or mux options.');
    if (settings.redirect) s.redirect = str(settings.redirect);
    if ('userLevel' in settings) s.userLevel = Number(settings.userLevel);
    if ('proxyProtocol' in settings) s.proxyProtocol = String(settings.proxyProtocol);
    const extra = keys(settings, ['redirect', 'userLevel', 'proxyProtocol']);
    if (Object.keys(extra).length) s.freedomExtra = json(extra);
  } else {
    let account = settings;
    if (kind === 'socks-outbound') {
      if (!settings.address && jsonArray(settings.servers)) {
        if (settings.servers.length !== 1)
          throw new Error(
            'One SOCKS server is required per outbound node; use a policy group for multiple servers.',
          );
        const server = record(settings.servers[0]),
          users = server.users;
        if (users !== undefined && (!jsonArray(users) || users.length > 1))
          throw new Error('At most one SOCKS account is supported per outbound node.');
        if (
          Object.keys(keys(settings, ['servers'])).length ||
          Object.keys(keys(server, ['address', 'port', 'users'])).length
        )
          throw new Error('Unmapped legacy SOCKS server options.');
        account = {
          ...record(jsonArray(users) ? users[0] : undefined),
          address: server.address,
          port: server.port,
        };
        if (jsonArray(users) && users.length && !str(account.user))
          throw new Error(
            'An authenticated SOCKS account needs a nonempty username. Original retained.',
          );
      }
      s.address = str(account.address);
      s.port = Number(account.port);
      s.auth = str(account.user) ? 'password' : 'none';
      s.username = str(account.user);
      s.password = str(account.pass);
      if ('email' in account) s.email = str(account.email);
      if ('level' in account) s.userLevel = Number(account.level);
      const extra = keys(account, ['address', 'port', 'user', 'pass', 'email', 'level', 'servers']);
      if (Object.keys(extra).length) s.protocolExtra = json(extra);
    } else {
      if (jsonArray(settings.vnext)) {
        if (settings.vnext.length !== 1)
          throw new Error('Multiple VLESS servers cannot fit one outbound node.');
        const server = record(settings.vnext[0]),
          users = server.users;
        if (!jsonArray(users) || users.length !== 1)
          throw new Error('One VLESS user is required per node.');
        account = {
          ...record(users[0]),
          address: server.address,
          port: server.port,
        };
        if (
          Object.keys(keys(settings, ['vnext'])).length ||
          Object.keys(keys(server, ['address', 'port', 'users'])).length
        )
          throw new Error('Unmapped legacy VLESS server options.');
      }
      for (const key of ['address', 'id', 'encryption', 'flow', 'email'])
        if (key in account) s[key] = str(account[key]);
      s.port = Number(account.port);
      s.encryption = s.encryption || 'none';
      s.flow = s.flow || '';
      if ('level' in account) s.userLevel = Number(account.level);
      if (account.reverse) s.reverse = json(account.reverse);
      const extra = keys(account, [
        'address',
        'port',
        'id',
        'encryption',
        'flow',
        'email',
        'level',
        'reverse',
      ]);
      if (Object.keys(extra).length) s.protocolExtra = json(extra);
    }
    const n = str(stream.network) || 'raw';
    s.network = n === 'tcp' ? 'raw' : n === 'splithttp' ? 'xhttp' : n;
    s.security = str(stream.security) || 'none';
    if ('address' in stream) s.streamAddress = str(stream.address);
    if ('port' in stream) s.streamPort = Number(stream.port);
    if (o.targetStrategy) s.targetStrategy = str(o.targetStrategy);
    if (stream.finalmask) s.finalmask = json(stream.finalmask);
    const transportKeys = [
      'rawSettings',
      'tcpSettings',
      'wsSettings',
      'httpupgradeSettings',
      'xhttpSettings',
      'splithttpSettings',
      'grpcSettings',
      'kcpSettings',
      'hysteriaSettings',
      'xdriveSettings',
    ];
    if (
      Object.keys(
        keys(stream, [
          'network',
          'security',
          'sockopt',
          'tlsSettings',
          'realitySettings',
          'address',
          'port',
          'finalmask',
          ...transportKeys,
        ]),
      ).length
    )
      throw new Error('Unmapped stream settings.');
    const active: Record<string, string[]> = {
      raw: ['rawSettings', 'tcpSettings'],
      ws: ['wsSettings'],
      httpupgrade: ['httpupgradeSettings'],
      xhttp: ['xhttpSettings', 'splithttpSettings'],
      grpc: ['grpcSettings'],
      kcp: ['kcpSettings'],
      hysteria: ['hysteriaSettings'],
      xdrive: ['xdriveSettings'],
    };
    const unused = transportKeys.filter(
      (k) => stream[k] && !active[String(s.network)]?.includes(k),
    );
    if (unused.length)
      throw new Error(`Inactive transport settings retained but not mapped: ${unused.join(', ')}.`);
    const t = record(active[String(s.network)]?.map((k) => stream[k]).find(Boolean));
    if (s.network === 'raw') {
      const h = record(t.header),
        r = record(h.request);
      s.rawHeaderType = str(h.type) || 'none';
      s.rawHeader = json(h);
      s.rawHost = list(record(r.headers).Host);
      s.rawPath = list(r.path) || '/';
      if (jsonArray(r.path) && r.path.length > 1)
        throw new Error('Multiple RAW request paths cannot fit the current node.');
      if (Object.keys(keys(t, ['header'])).length)
        throw new Error('Unmapped RAW transport fields.');
    }
    if (['ws', 'httpupgrade', 'xhttp'].includes(String(s.network))) {
      s.host = str(t.host) || str(record(t.headers).Host);
      s.path = str(t.path) || '/';
      const allowed =
        s.network === 'xhttp'
          ? ['host', 'path', 'mode', 'extra']
          : s.network === 'ws'
            ? ['host', 'path', 'headers', 'heartbeatPeriod']
            : ['host', 'path', 'headers'];
      if (Object.keys(keys(t, allowed)).length) throw new Error('Unmapped HTTP transport fields.');
      if (s.network === 'xhttp') {
        if ('mode' in t) s.xhttpMode = str(t.mode);
        if (t.extra) s.xhttpExtra = json(t.extra);
      } else {
        if (t.headers) s.headers = json(t.headers);
        if ('heartbeatPeriod' in t) s.wsHeartbeat = Number(t.heartbeatPeriod);
      }
    }
    if (s.network === 'grpc') {
      const m = {
        serviceName: 'grpcServiceName',
        authority: 'grpcAuthority',
        multiMode: 'grpcMultiMode',
        idle_timeout: 'grpcIdleTimeout',
        health_check_timeout: 'grpcHealthTimeout',
        permit_without_stream: 'grpcPermitWithoutStream',
        initial_windows_size: 'grpcInitialWindow',
        user_agent: 'userAgent',
      };
      for (const [key, out] of Object.entries(m)) if (key in t) s[out] = t[key] as SettingValue;
      if (Object.keys(keys(t, Object.keys(m))).length) throw new Error('Unmapped gRPC fields.');
    }
    if (s.network === 'kcp') {
      const m = {
        mtu: 'kcpMtu',
        tti: 'kcpTti',
        uplinkCapacity: 'kcpUp',
        downlinkCapacity: 'kcpDown',
        cwndMultiplier: 'kcpCwnd',
        maxSendingWindow: 'kcpWindow',
      };
      for (const [key, out] of Object.entries(m)) if (key in t) s[out] = t[key] as SettingValue;
      if (Object.keys(keys(t, Object.keys(m))).length)
        throw new Error('Legacy mKCP fields require a native FinalMask configuration.');
    }
    if (s.network === 'hysteria') {
      if (t.version && t.version !== 2) throw new Error('Only Hysteria 2 transport is mapped.');
      if (t.auth) s.hysteriaAuth = str(t.auth);
      if ('udpIdleTimeout' in t) s.hysteriaUdpTimeout = Number(t.udpIdleTimeout);
      if (Object.keys(keys(t, ['version', 'auth', 'udpIdleTimeout'])).length)
        throw new Error('Unmapped Hysteria transport options.');
    }
    if (s.network === 'xdrive') s.xdriveSettings = json(t);
    if (
      (stream.tlsSettings && s.security !== 'tls') ||
      (stream.realitySettings && s.security !== 'reality')
    )
      throw new Error('Inactive security settings are retained but cannot be mapped to this node.');
    const secure = record(s.security === 'reality' ? stream.realitySettings : stream.tlsSettings);
    if (secure.allowInsecure === true)
      throw new Error('Insecure TLS cannot be represented by the pinned core.');
    const m: Record<string, string> =
      s.security === 'reality'
        ? {
            serverName: 'serverName',
            fingerprint: 'fingerprint',
            password: 'realityPassword',
            publicKey: 'realityPassword',
            shortId: 'shortId',
            spiderX: 'spiderX',
            show: 'realityShow',
            mldsa65Verify: 'mldsa65Verify',
          }
        : {
            serverName: 'serverName',
            fingerprint: 'fingerprint',
            minVersion: 'tlsMinVersion',
            maxVersion: 'tlsMaxVersion',
            enableSessionResumption: 'sessionResumption',
            disableSystemRoot: 'disableSystemRoot',
            cipherSuites: 'cipherSuites',
            echConfigList: 'echConfigList',
            pinnedPeerCertSha256: 'pinnedPeerCertSha256',
            verifyPeerCertByName: 'verifyPeerCertByName',
          };
    for (const [key, out] of Object.entries(m))
      if (key in secure) s[out] = secure[key] as SettingValue;
    if (s.security === 'tls') {
      if (secure.alpn) s.alpn = list(secure.alpn);
      if (secure.curvePreferences) s.curvePreferences = list(secure.curvePreferences);
      if (secure.certificates) s.certificates = json(secure.certificates);
    }
    const securityExtra = keys(secure, [
      ...Object.keys(m),
      'alpn',
      'curvePreferences',
      'certificates',
      'allowInsecure',
    ]);
    if (Object.keys(securityExtra).length)
      s[s.security === 'reality' ? 'realityExtra' : 'tlsExtra'] = json(securityExtra);
    if (o.mux) {
      const mux = record(o.mux),
        m = {
          enabled: 'muxEnabled',
          concurrency: 'muxConcurrency',
          xudpConcurrency: 'xudpConcurrency',
          xudpProxyUDP443: 'xudpProxyUDP443',
        };
      for (const [key, out] of Object.entries(m)) if (key in mux) s[out] = mux[key] as SettingValue;
      if (Object.keys(keys(mux, Object.keys(m))).length) throw new Error('Unmapped mux fields.');
    }
  }
  return { kind, settings: s };
}

import { encodeStashGroup, decodeStashGroups } from './stashEncoding';
import { validHealth, normalizeMaintenance, validMaintenance } from './subscriptionState';
import { jsonText, jsonArray, jsonRecord, parseJson } from '../graph/xrayJson';
import { DEFAULT_GROUP_ID, type StashDraft } from './stashModel';
import { parseOverrides } from '../graph/defaults';
import { parseNativeProjection } from '../graph/xrayProjection';
import { validatePreparedProfile, remapPreparedSubscriptions } from '../graph/composites';
import { boundedText } from '../text';
import { getDefinition, validateSettings } from '../graph/catalog';
import { outboundProblems } from '../graph/outbounds';
import { fieldProblem } from '../graph/settingValidation';
import { normalizeUserAgent } from '../graph/trafficTuning';
import type { NodeKind, SettingValue } from '../graph/types';
import {
  commonKeys,
  hydrateProtocolCommon,
  isProtocolOutbound,
  protocolOutboundKinds,
  specForProtocol,
} from '../graph/protocols';
import { protocolLink } from './protocolLinks';
export const MAX_IMPORT = 32 * 1024 * 1024;
export const MAX_STASH = 64 * 1024 * 1024;
export const MAX_ENTRIES = 50000;
export type ProfileKind =
  | Extract<NodeKind, 'vless-outbound' | 'socks-outbound' | 'direct-outbound' | 'block-outbound'>
  | (typeof protocolOutboundKinds)[number]
  | 'policy-group'
  | 'proxy-chain'
  | 'xray-outbound';
export interface Profile {
  kind: ProfileKind;
  settings: Record<string, SettingValue>;
}
export interface StashEntry {
  starred?: boolean;
  sourceCopyOf?: string;
  health?: import('./subscriptionState').SubscriptionHealth;
  retained?: boolean;
  locked?: boolean;
  manual?: boolean;
  sourceName?: string;
  sourceProtocol?: string;
  draft?: StashDraft;
  id: string;
  name: string;
  protocol: string;
  address: string;
  raw: string;
  profile: Profile | null;
  problem: string;
}
export interface StashGroup {
  maintenancePaused?: boolean;
  maintenance?: import('./subscriptionState').SubscriptionMaintenance;
  lastTestAt?: number;
  testCycleAt?: number;
  id: string;
  name: string;
  url: string;
  userAgent: string;
  headers: Record<string, string>;
  allowHttp: boolean;
  updatedAt: number | null;
  entries: StashEntry[];
}
export interface Stash {
  format: 'wayrill.stash';
  version: 3;
  groups: StashGroup[];
}
export interface ImportResult {
  groups: StashGroup[];
  duplicates: number;
  rejected: number;
  problems: string[];
}
const record = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !jsonArray(x) ? (x as Record<string, unknown>) : {};
const str = (x: unknown) => (typeof x === 'string' ? x : '');
const json = (x: unknown) => JSON.stringify(x);
const list = (x: unknown) => (jsonArray(x) ? x.join(', ') : str(x));
const keys = (x: Record<string, unknown>, excluded: string[]) =>
  Object.fromEntries(Object.entries(x).filter(([key]) => !excluded.includes(key)));
const label = (x: string, fallback: string) => boundedText(x.trim(), 128) || fallback;
export function decodeBase64(text: string): string {
  const cleaned = text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) throw new Error('Invalid Base64 subscription.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, '=')), (c) =>
        c.charCodeAt(0),
      ),
    );
  } catch {
    throw new Error('Invalid Base64 or UTF-8 subscription.');
  }
}
function checked(kind: ProfileKind, settings: Record<string, SettingValue>): Profile {
  const merged = validateSettings(kind, {
    ...getDefinition(kind).defaults,
    ...settings,
  });
  for (const field of getDefinition(kind).fields) {
    const problem = fieldProblem(field, merged);
    if (problem) throw new Error(`${field.label}: ${problem}`);
  }
  const problem = outboundProblems({
    kind,
    label: '',
    description: '',
    settings: merged,
  }).find((p) => p.severity === 'error');
  if (problem) throw new Error(problem.message);
  return { kind, settings };
}
export function vlessLink(text: string): Profile {
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
  return checked('vless-outbound', s);
}
export function xrayOutbound(raw: unknown): Profile {
  const o = record(raw),
    settings = record(o.settings),
    stream = record(o.streamSettings),
    s: Record<string, SettingValue> = {};
  const protocol = str(o.protocol),
    spec = specForProtocol(protocol, 'outbound');
  if (spec && isProtocolOutbound(spec.kind)) {
    const value = { ...o };
    delete value.tag;
    const shared = hydrateProtocolCommon(o, getDefinition(spec.kind).defaults, 'outbound');
    return checked(spec.kind, {
      ...shared,
      tag: str(o.tag) || `${spec.protocol}-output`,
      json: JSON.stringify(value),
      commonBaseline: JSON.stringify(
        Object.fromEntries(commonKeys(spec.kind).map((key) => [key, shared[key]])),
      ),
    });
  }
  const canonical = spec?.protocol ?? protocol;
  const kind: ProfileKind =
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
    const agent = normalizeUserAgent(
      { ...getDefinition(kind).defaults, ...s },
      s.network === 'raw' ? 'rawHeader' : s.network === 'xhttp' ? 'xhttpExtra' : 'headers',
    );
    if (agent.found) {
      s.userAgent = agent.settings.userAgent;
      for (const key of ['headers', 'rawHeader', 'xhttpExtra'])
        if (key in s) s[key] = agent.settings[key];
    }
  }
  return checked(kind, s);
}
export function parseEntry(raw: string, index = 1): StashEntry {
  const result: StashEntry = {
    id: crypto.randomUUID(),
    name: `Configuration ${index}`,
    protocol: 'unknown',
    address: '',
    raw,
    profile: null,
    problem: '',
  };
  if (raw.length > 128 * 1024) {
    result.problem = 'Entry exceeds 128 KiB.';
    return result;
  }
  try {
    if (raw.trim().startsWith('{')) {
      const o = record(parseJson(raw));
      result.name = label(str(o.tag), result.name);
      result.protocol = str(o.protocol) || 'unknown';
      result.profile = xrayOutbound(o);
    } else {
      const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
      if (!match) throw new Error('Unrecognized configuration format.');
      result.protocol = match[1].toLowerCase();
      try {
        const u = new URL(raw);
        result.name = label(decodeURIComponent(u.hash.slice(1)), result.name);
        if (result.protocol === 'vless' || u.username)
          result.address = u.hostname.replace(/^\[|\]$/g, '');
      } catch {
        /* Protocol-specific opaque URI; retain original. */
      }
      if (result.protocol === 'vless') result.profile = vlessLink(raw);
      else {
        const parsed = protocolLink(raw, decodeBase64);
        if (parsed.name) result.name = label(parsed.name, result.name);
        result.profile = xrayOutbound(parsed.config);
        result.address = jsonText(record(parsed.config.settings).address ?? result.address);
      }
    }
    result.address = String(result.profile.settings.address ?? result.address);
  } catch (problem) {
    result.problem = problem instanceof Error ? problem.message : 'Could not map configuration.';
  }
  return result;
}
function newGroup(name: string): StashGroup {
  return {
    id: crypto.randomUUID(),
    name: label(name, 'Imported configurations'),
    url: '',
    userAgent: '',
    headers: {},
    allowHttp: false,
    updatedAt: Date.now(),
    entries: [],
  };
}
function metadata(raw: unknown): StashGroup | null {
  const o = record(raw);
  const url = str(o.url ?? o.Url);
  if (!url) return null;
  const group = newGroup(str(o.remarks ?? o.Remarks ?? o.name));
  group.url = url;
  group.userAgent = str(o.userAgent ?? o.UserAgent);
  group.allowHttp = o.allowInsecureUrl === true;
  group.updatedAt = null;
  const headers = o.requestHeaders ?? o.RequestHeaders;
  if (headers) {
    let h: unknown = headers;
    if (typeof headers === 'string') h = parseJson(headers);
    if (!Object.values(record(h)).every((v) => typeof v === 'string'))
      throw new Error('Request headers must contain text values.');
    group.headers = record(h) as Record<string, string>;
  }
  return group;
}
export function importProfiles(input: string, name = 'Imported configurations'): ImportResult {
  const bytes = new TextEncoder().encode(input).length;
  if (bytes > MAX_IMPORT) {
    if (bytes <= MAX_STASH && input.trimStart().startsWith('{')) {
      try {
        const o: unknown = parseJson(input);
        if (jsonRecord(o) && o.format === 'wayrill.stash')
          return {
            ...parseStash(input),
            duplicates: 0,
            rejected: 0,
            problems: [],
          };
      } catch {
        /* Preserve the generic size error for other inputs. */
      }
    }
    throw new Error('Import exceeds 32 MiB; Wayrill stash files support 64 MiB.');
  }
  let text = input.replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('The import is empty.');
  if (!text.startsWith('{') && !text.startsWith('[') && !text.includes('://'))
    text = decodeBase64(text).trim();
  const result: ImportResult = {
      groups: [],
      duplicates: 0,
      rejected: 0,
      problems: [],
    },
    group = newGroup(name);
  let rows: unknown[];
  if (text.startsWith('{') || text.startsWith('[')) {
    let value: unknown;
    try {
      value = parseJson(text);
    } catch {
      throw new Error('Invalid subscription/configuration JSON.');
    }
    const o = record(value);
    if (jsonRecord(o) && o.format === 'wayrill.stash')
      return { ...parseStash(text), duplicates: 0, rejected: 0, problems: [] };
    if (jsonArray(value)) rows = value;
    else if (jsonArray(o.outbounds)) rows = o.outbounds;
    else if (jsonArray(o.subItem)) rows = o.subItem;
    else if (jsonArray(o.subscriptions)) rows = o.subscriptions;
    else rows = [value];
  } else
    rows = text
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith('#'));
  if (rows.length > MAX_ENTRIES) throw new Error('An import may contain at most 50,000 entries.');
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const sub = typeof row === 'object' ? metadata(row) : null;
    if (sub) {
      const source = record(row);
      if (
        ['MoreUrl', 'moreUrl', 'ConvertTarget', 'convertTarget', 'Filter', 'filter'].some(
          (key) => source[key],
        )
      )
        result.problems.push(
          `Group ${sub.name}: source-app conversion, extra URLs and filter preferences are not imported. Add extra URLs as separate groups.`,
        );
      result.groups.push(sub);
      return;
    }
    const entry = parseEntry(typeof row === 'string' ? row : json(row), index + 1);
    if (entry.protocol === 'unknown') {
      result.rejected++;
      if (result.problems.length < 30) result.problems.push(`Entry ${index + 1}: ${entry.problem}`);
      return;
    }
    const identity = entry.profile
      ? json([
          entry.profile.kind,
          Object.entries(entry.profile.settings)
            .filter(([key]) => key !== 'tag')
            .sort(([a], [b]) => a.localeCompare(b)),
        ])
      : entry.raw;
    if (seen.has(identity)) {
      result.duplicates++;
      return;
    }
    seen.add(identity);
    group.entries.push(entry);
  });
  if (group.entries.length) result.groups.unshift(group);
  if (!result.groups.length)
    throw new Error('No recognizable configurations or subscription groups were found.');
  return result;
}
export function parseStash(text: string): Stash {
  if (new TextEncoder().encode(text).length > 64 * 1024 * 1024)
    throw new Error('Stash exceeds 64 MiB.');
  const value = record(parseJson(text));
  if (
    value.format === 'wayrill.stash' &&
    value.version === 4 &&
    jsonArray(value.groups) &&
    value.groups.length <= 500
  ) {
    decodeStashGroups(value.groups);
    value.version = 3;
  }
  if (
    value.format !== 'wayrill.stash' ||
    value.version !== 3 ||
    !jsonArray(value.groups) ||
    value.groups.length > 500
  )
    throw new Error('Unsupported stash file.');
  const ids = new Set<string>();
  let count = 0;
  for (const raw of value.groups) {
    const g = record(raw);
    if (
      typeof g.id !== 'string' ||
      ids.has(g.id) ||
      typeof g.name !== 'string' ||
      typeof g.url !== 'string' ||
      !jsonArray(g.entries) ||
      typeof g.userAgent !== 'string' ||
      typeof g.allowHttp !== 'boolean' ||
      !jsonRecord(g.headers) ||
      !Object.values(g.headers).every((x) => typeof x === 'string')
    )
      throw new Error('Invalid stash group.');
    if (g.id === DEFAULT_GROUP_ID && (g.name !== 'Default' || g.url !== ''))
      throw new Error('Invalid Default group.');
    if (g.maintenance !== undefined) g.maintenance = normalizeMaintenance(g.maintenance);
    if (
      (g.maintenance !== undefined && !validMaintenance(g.maintenance)) ||
      (g.maintenancePaused !== undefined && typeof g.maintenancePaused !== 'boolean') ||
      ['lastTestAt', 'testCycleAt'].some(
        (key) => g[key] !== undefined && (!Number.isSafeInteger(g[key]) || Number(g[key]) < 0),
      )
    )
      throw new Error('Invalid subscription maintenance settings.');
    ids.add(g.id);
    count += g.entries.length;
    const entryIds = new Set<string>();
    for (const rawEntry of g.entries) {
      const e = record(rawEntry);
      if (
        typeof e.id !== 'string' ||
        entryIds.has(e.id) ||
        ['name', 'raw', 'protocol', 'address', 'problem'].some((k) => typeof e[k] !== 'string')
      )
        throw new Error('Invalid stash entry.');
      entryIds.add(e.id);
      if (
        ['locked', 'manual', 'retained', 'starred'].some(
          (k) => e[k] !== undefined && typeof e[k] !== 'boolean',
        ) ||
        (e.health !== undefined && !validHealth(e.health)) ||
        ['sourceName', 'sourceProtocol', 'sourceCopyOf'].some(
          (k) => e[k] !== undefined && (typeof e[k] !== 'string' || String(e[k]).length > 1024),
        )
      )
        throw new Error('Invalid Stash protection metadata.');
      if (e.draft !== undefined) {
        const d = record(e.draft);
        if (
          ![
            'vless-outbound',
            'socks-outbound',
            'direct-outbound',
            'block-outbound',
            ...protocolOutboundKinds,
            'policy-group',
            'proxy-chain',
            'xray-outbound',
          ].includes(str(d.kind)) ||
          typeof d.description !== 'string' ||
          d.description.length > 4096
        )
          throw new Error('Invalid Stash draft.');
        validateSettings(d.kind as NodeKind, d.settings);
        parseOverrides(d.kind as NodeKind, d.overrides);
        if (d.native !== undefined) parseNativeProjection(d.native);
        if (e.profile && record(e.profile).kind !== d.kind)
          throw new Error('Stash draft and profile kinds differ.');
      }
      if (e.profile) {
        const p = record(e.profile);
        if (
          ![
            'vless-outbound',
            'socks-outbound',
            'direct-outbound',
            'block-outbound',
            ...protocolOutboundKinds,
            'policy-group',
            'proxy-chain',
            'xray-outbound',
          ].includes(str(p.kind))
        )
          throw new Error('Invalid stash node kind.');
        checked(p.kind as ProfileKind, record(p.settings) as Record<string, SettingValue>);
        if (['policy-group', 'proxy-chain'].includes(str(p.kind)))
          validatePreparedProfile(p as unknown as Profile);
      }
    }
  }
  if (count > MAX_ENTRIES) throw new Error('The stash supports 50,000 entries total.');
  return value as unknown as Stash;
}
// History retains old Stash objects. WeakMap values would therefore retain a
// full serialized subscription for every undo snapshot. Cache only the latest
// document, reusing its unchanged groups on the next serialization.
export interface SerializedGroup {
  text: string;
  bytes: number;
}
let serialized:
  | { stash: Stash; text: string; bytes: number; groups: Map<StashGroup, SerializedGroup> }
  | undefined;
export function seedStashSerialization(stash: Stash, groups: SerializedGroup[]): void {
  const text = `{"format":"wayrill.stash","version":4,"groups":[${groups.map((g) => g.text).join(',')}]}`;
  serialized = {
    stash,
    text,
    bytes: 0,
    groups: new Map(stash.groups.map((g, i) => [g, groups[i]])),
  };
  // The fixed ASCII envelope is measured rather than coupled to its spelling.
  serialized.bytes =
    new TextEncoder().encode('{"format":"wayrill.stash","version":4,"groups":[]}').length +
    Math.max(0, groups.length - 1) +
    groups.reduce((sum, g) => sum + g.bytes, 0);
}
export function serializedStashGroups(stash: Stash): SerializedGroup[] {
  if (serialized?.stash !== stash) {
    const encoder = new TextEncoder();
    const groups = stash.groups.map((group) => {
      const cached = serialized?.groups.get(group);
      if (cached) return cached;
      const text = encodeStashGroup(group);
      return { text, bytes: encoder.encode(text).length };
    });
    seedStashSerialization(stash, groups);
  }
  return stash.groups.map((g) => serialized!.groups.get(g)!);
}
export function serializeStash(stash: Stash): string {
  serializedStashGroups(stash);
  return serialized!.text;
}
export function stashByteLength(stash: Stash): number {
  serializedStashGroups(stash);
  return serialized!.bytes;
}
const entryIdentity = (entry: StashEntry) =>
  entry.profile
    ? json([
        entry.profile.kind,
        Object.entries(entry.profile.settings)
          .filter(([key]) => key !== 'tag')
          .sort(([a], [b]) => a.localeCompare(b)),
      ])
    : entry.raw;
export function refreshSummary(before: StashGroup, after: StashGroup) {
  const old = new Map(before.entries.map((entry) => [entry.id, entry]));
  let added = 0,
    updated = 0,
    unchanged = 0;
  for (const entry of after.entries) {
    const previous = old.get(entry.id);
    if (!previous) added++;
    else {
      if (json({ ...previous, id: '' }) === json({ ...entry, id: '' })) unchanged++;
      else updated++;
      old.delete(entry.id);
    }
  }
  return {
    added,
    updated,
    unchanged,
    removed: old.size,
    unsupported: after.entries.filter((entry) => !entry.profile).length,
  };
}
function reconcileEntries(
  old: StashEntry[],
  incoming: StashEntry[],
  protectedIds: ReadonlySet<string>,
): StashEntry[] {
  const identities = new Map<string, StashEntry[]>();
  // Reverse once and pop so matching preserves source order without the
  // quadratic array shifts caused by large sets of equivalent profiles.
  for (let i = old.length - 1; i >= 0; i--) {
    const entry = old[i];
    const key = entryIdentity(entry);
    const entries = identities.get(key) ?? [];
    entries.push(entry);
    identities.set(key, entries);
  }
  const used = new Set<string>();
  const matches = incoming.map((entry) => {
    const previous = identities.get(entryIdentity(entry))?.pop();
    if (previous) used.add(previous.id);
    return previous;
  });
  // Only unique unmatched names can identify a changed configuration. Repeated
  // names are ambiguous, so their replacements are reported as added/removed.
  const key = (e: StashEntry) => json([e.sourceName ?? e.name, e.sourceProtocol ?? e.protocol]);
  const remaining = new Map<string, StashEntry[]>(),
    counts = new Map<string, number>();
  for (const entry of old)
    if (!used.has(entry.id)) {
      const name = key(entry),
        entries = remaining.get(name) ?? [];
      entries.push(entry);
      remaining.set(name, entries);
    }
  incoming.forEach((entry, i) => {
    if (!matches[i]) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
  });
  const kept = new Set<string>();
  const refreshed = incoming.map((entry, i) => {
    const options = remaining.get(key(entry));
    const unlocked = options?.filter((e) => !e.locked && !e.manual);
    const copies = unlocked?.filter((e) => e.sourceCopyOf);
    const alternatives = copies?.length ? copies : unlocked?.length ? unlocked : options;
    const previous =
      matches[i] ??
      (counts.get(key(entry)) === 1 && alternatives?.length === 1 ? alternatives[0] : undefined);
    if (!previous) return entry;
    kept.add(previous.id);
    if ((previous.locked || previous.manual) && entryIdentity(previous) !== entryIdentity(entry)) {
      kept.delete(previous.id);
      return { ...entry, sourceCopyOf: previous.id };
    }
    const next =
      previous.locked || previous.manual
        ? previous
        : {
            ...entry,
            id: previous.id,
            ...(previous.starred === undefined ? {} : { starred: previous.starred }),
            ...(previous.sourceCopyOf ? { sourceCopyOf: previous.sourceCopyOf } : {}),
            ...(entryIdentity(previous) === entryIdentity(entry) && previous.health
              ? { health: previous.health }
              : {}),
            ...(previous.locked === undefined ? {} : { locked: previous.locked }),
          };
    return next === previous || json(next) === json(previous) ? previous : next;
  });
  const copies = new Map(
    refreshed.filter((entry) => entry.sourceCopyOf).map((entry) => [entry.sourceCopyOf!, entry]),
  );
  const restored = old.flatMap((entry) => {
    if (entry.locked || entry.manual || kept.has(entry.id)) return [];
    const update = copies.get(entry.id);
    if (!update) return [];
    kept.add(entry.id);
    const next = { ...update, id: entry.id, starred: entry.starred };
    delete next.sourceCopyOf;
    return [next];
  });
  const restoredIds = new Set(restored.map((entry) => entry.id));
  return [
    ...refreshed.filter(
      (entry) =>
        !entry.sourceCopyOf ||
        !restoredIds.has(entry.sourceCopyOf) ||
        entry.locked ||
        entry.manual ||
        protectedIds.has(entry.id),
    ),
    ...restored,
    ...old
      .filter((e) => (e.locked || e.manual || protectedIds.has(e.id)) && !kept.has(e.id))
      .map((e) => (e.locked || e.manual || e.retained ? e : { ...e, retained: true })),
  ];
}
export function mergeImport(
  stash: Stash,
  result: ImportResult,
  replaceId?: string,
  protectedLinks: ReadonlySet<string> = new Set(),
): Stash {
  let groups: StashGroup[];
  const groupIds = new Map<string, string>();
  if (replaceId) {
    const old = stash.groups.find((g) => g.id === replaceId);
    if (
      !old ||
      result.groups.length !== 1 ||
      result.groups[0].url ||
      !result.groups[0].entries.length
    )
      throw new Error(
        'A subscription refresh must return one configuration list with non-empty entries. Existing entries were preserved.',
      );
    const protectedIds = new Set(
      old.entries
        .filter((e) => protectedLinks.has(JSON.stringify([old.id, e.id])))
        .map((e) => e.id),
    );
    const entries = reconcileEntries(old.entries, result.groups[0].entries, protectedIds);
    groups = stash.groups.map((g) =>
      g.id === replaceId
        ? {
            ...g,
            entries,
            updatedAt: Date.now(),
            ...(g.maintenance?.removeUnreachable ? { testCycleAt: Date.now() } : {}),
          }
        : g,
    );
  } else {
    const ids = new Set(stash.groups.map((g) => g.id));
    groups = [
      ...stash.groups,
      ...result.groups.map((group) => {
        const id =
          ids.has(group.id) || group.id === DEFAULT_GROUP_ID ? crypto.randomUUID() : group.id;
        ids.add(id);
        groupIds.set(group.id, id);
        return { ...group, id };
      }),
    ];
  }
  if (groups.length > 500 || groups.reduce((n, g) => n + g.entries.length, 0) > MAX_ENTRIES)
    throw new Error('The stash supports 500 groups and 50,000 entries total.');
  // Every kind has a real subscription/manual-group owner. Imported group IDs
  // are remapped recursively inside prepared definitions and their edit drafts.
  const newIds = new Set(result.groups.map((g) => groupIds.get(g.id)).filter(Boolean));
  if (!replaceId)
    groups = groups.map((g) =>
      !newIds.has(g.id)
        ? g
        : {
            ...g,
            ...(g.id !== DEFAULT_GROUP_ID && g.name === 'Default'
              ? { name: 'Default (imported)' }
              : {}),
            entries: g.entries.map((e) => {
              const profile = e.profile && remapPreparedSubscriptions(e.profile, groupIds);
              const draft = e.draft && {
                ...e.draft,
                settings: remapPreparedSubscriptions(
                  { kind: e.draft.kind, settings: e.draft.settings },
                  groupIds,
                ).settings,
              };
              return {
                ...e,
                ...(profile ? { profile } : {}),
                ...(draft ? { draft } : {}),
              };
            }),
          },
    );
  const next: Stash = { format: 'wayrill.stash', version: 3, groups };
  if (stashByteLength(next) > MAX_STASH)
    throw new Error('The stash exceeds 64 MiB. Existing groups were preserved.');
  return next;
}

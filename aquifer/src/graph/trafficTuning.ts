import { jsonRecord, jsonArray, parseXrayJson, parseJson } from './xrayJson';
import type { Diagnostic, RuleNodeData, SettingDefinition, SettingValue } from './types';

// Windows UDP sockets otherwise inherit the OS's small datagram buffers.
// Scope the options to UDP; TCP keeps its existing socket/autotuning behavior.
export const windowsUdpSocketOptions = [4098, 4097].map((opt) => ({
  system: 'windows',
  network: 'udp',
  level: '65535',
  opt: String(opt),
  value: String(256 * 1024),
  type: 'int',
}));

const field = (
  section: string,
  key: string,
  label: string,
  type: SettingDefinition['type'],
  defaultValue: SettingValue,
  extra: Partial<SettingDefinition> = {},
): SettingDefinition => ({ section, key, label, type, defaultValue, required: false, ...extra });
export const fragmentFields: SettingDefinition[] = [
  field('fragment', 'fragmentEnabled', 'Fragment before transport security', 'boolean', false, {
    help: 'Fragments the secured connection to the VLESS server, using Xray FinalMask. Applies to TCP transports with TLS/REALITY.',
  }),
  field('fragment', 'finalFragmentEnabled', 'Fragment traffic inside VLESS', 'boolean', false, {
    help: 'Adds a Direct wrapper that fragments client TCP data before passing it through VLESS. This is v2rayN’s separate final-fragment stage.',
  }),
  field('fragment', 'fragmentPackets', 'Packets to fragment', 'text', 'tlshello', {
    help: 'tlshello, a packet number, or a range such as 1-3. Applies to both stages. Blank fragments all TCP packets.',
    required: false,
  }),
  field('fragment', 'fragmentLengths', 'Fragment lengths (bytes)', 'textarea', '50-100', {
    help: 'Comma/newline-separated values or ranges, in order. The last range must start above zero.',
    required: true,
  }),
  field('fragment', 'fragmentDelays', 'Fragment delays (milliseconds)', 'textarea', '10-20', {
    help: 'Comma/newline-separated values or ranges, in order.',
    required: true,
  }),
  field('fragment', 'fragmentMaxSplit', 'Maximum splits', 'text', '0', {
    help: 'A number or range; 0 leaves the number of splits unlimited.',
    required: true,
  }),
];
export const happyEyeballsFields: SettingDefinition[] = [
  field('socket', 'happyEyeballsEnabled', 'Happy Eyeballs address racing', 'boolean', false, {
    help: 'Races resolved IPv4/IPv6 addresses. Requires an Xray DNS address strategy rather than AsIs.',
  }),
  field('socket', 'happyEyeballsDelay', 'Address-race delay (milliseconds)', 'number', 0, {
    min: 0,
    max: 2147483647,
    visibleWhen: { happyEyeballsEnabled: true },
  }),
  field('socket', 'happyEyeballsIPv6', 'Prefer IPv6 in address racing', 'boolean', false, {
    visibleWhen: { happyEyeballsEnabled: true },
  }),
  field('socket', 'happyEyeballsInterleave', 'Address-race interleave', 'number', 1, {
    min: 1,
    max: 4294967295,
    visibleWhen: { happyEyeballsEnabled: true },
  }),
  field('socket', 'happyEyeballsMax', 'Maximum concurrent address attempts', 'number', 4, {
    min: 1,
    max: 4294967295,
    visibleWhen: { happyEyeballsEnabled: true },
  }),
];
export const transportTuningFields: SettingDefinition[] = [
  field('transport', 'userAgent', 'Transport User-Agent', 'text', '', {
    visibleWhen: { network: ['raw', 'ws', 'httpupgrade', 'grpc', 'xhttp'] },
    help: 'HTTP camouflage/transport or gRPC User-Agent. This does not rewrite the browser’s application requests. Blank uses the transport default.',
  }),
  field('transport', 'hysteriaUp', 'Hysteria upload (Mbps)', 'number', 0, {
    min: 0,
    max: 2147483647,
    visibleWhen: { network: 'hysteria' },
    help: 'Positive bandwidth selects Brutal congestion control; both zero leave BBR/core configuration.',
  }),
  field('transport', 'hysteriaDown', 'Hysteria download (Mbps)', 'number', 0, {
    min: 0,
    max: 2147483647,
    visibleWhen: { network: 'hysteria' },
  }),
  field('transport', 'hysteriaPorts', 'Hysteria hopping ports', 'text', '', {
    visibleWhen: { network: 'hysteria' },
    help: 'Optional server-supported ports/ranges, for example 443,10000-10100. This stays specific to the node.',
  }),
  field('transport', 'hysteriaHopInterval', 'Hysteria hop interval (seconds)', 'text', '30', {
    visibleWhen: { network: 'hysteria' },
    help: 'Number or range of at least 5 seconds. Used only when hopping ports are configured.',
  }),
];
export const tcpTransports = ['raw', 'xhttp', 'ws', 'grpc', 'httpupgrade'];
export const rangeParts = (value: SettingValue) =>
  String(value)
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
export function validRange(value: string, min = 0, max = 2147483647): boolean {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!match) return false;
  const from = Number(match[1]),
    to = Number(match[2] ?? match[1]);
  return (
    Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= min && to >= from && to <= max
  );
}
export function tuningProblems(data: RuleNodeData): Diagnostic[] {
  const s = data.settings,
    issues: Diagnostic[] = [];
  const add = (fieldKey: string, message: string, severity: Diagnostic['severity'] = 'error') =>
    issues.push({ fieldKey, message, severity });
  if (data.kind === 'vless-outbound' || data.kind === 'socks-outbound') {
    if (s.userAgent && /[\r\n\0]/.test(String(s.userAgent)))
      add('userAgent', 'User-Agent cannot contain line breaks or NUL.');
    if (s.fragmentEnabled || s.finalFragmentEnabled) {
      if (
        s.fragmentPackets &&
        s.fragmentPackets !== 'tlshello' &&
        !validRange(String(s.fragmentPackets), 1)
      )
        add('fragmentPackets', 'Use tlshello or a positive packet number/range.');
      const lengths = rangeParts(s.fragmentLengths),
        delays = rangeParts(s.fragmentDelays);
      if (!lengths.length || lengths.some((v) => !validRange(v)) || !validRange(lengths.at(-1)!, 1))
        add(
          'fragmentLengths',
          'Use ordered nonnegative ranges; the final length range must start above zero.',
        );
      if (!delays.length || delays.some((v) => !validRange(v)))
        add('fragmentDelays', 'Use nonnegative delay values/ranges.');
      if (!validRange(String(s.fragmentMaxSplit)))
        add('fragmentMaxSplit', 'Use a nonnegative split number/range.');
      try {
        const mask = s.finalmask ? parseXrayJson(String(s.finalmask)) : {};
        const tcp = jsonRecord(mask) && jsonArray(mask.tcp) ? mask.tcp : [];
        if (s.fragmentEnabled && tcp.some((m) => jsonRecord(m) && m.type === 'fragment'))
          add(
            'finalmask',
            'A custom TCP fragment mask is already configured. Disable the named pre-security fragment stage or remove the custom fragment mask.',
          );
      } catch {
        /* JSON field validation supplies the diagnostic. */
      }
    }
    if (s.network === 'hysteria' && s.hysteriaPorts) {
      if (rangeParts(s.hysteriaPorts).some((p) => !validRange(p, 1, 65535)))
        add('hysteriaPorts', 'Use valid server port numbers/ranges.');
      if (!validRange(String(s.hysteriaHopInterval), 5))
        add('hysteriaHopInterval', 'Use a hop interval/range of at least 5 seconds.');
    }
  }
  if (s.happyEyeballsEnabled && s.domainStrategy === 'AsIs')
    add(
      'happyEyeballsEnabled',
      'AsIs uses the system resolver; select an Xray DNS address strategy to use address racing.',
      'warning',
    );
  return issues;
}
export function fragmentMask(settings: Record<string, SettingValue>) {
  return {
    type: 'fragment',
    settings: {
      packets: settings.fragmentPackets,
      lengths: rangeParts(settings.fragmentLengths),
      delays: rangeParts(settings.fragmentDelays),
      maxSplit: String(settings.fragmentMaxSplit),
    },
  };
}
export function tunedFinalMask(data: RuleNodeData): Record<string, unknown> {
  const s = data.settings,
    raw = s.finalmask ? parseXrayJson(String(s.finalmask)) : {},
    mask = jsonRecord(raw) ? raw : {};
  if (s.network === 'hysteria') {
    const quic = { ...((mask.quicParams as Record<string, unknown>) ?? {}) };
    if (Number(s.hysteriaUp) > 0 || Number(s.hysteriaDown) > 0) {
      Object.assign(quic, {
        congestion: 'brutal',
        ...(s.hysteriaUp ? { brutalUp: String(s.hysteriaUp) + 'mbps' } : {}),
        ...(s.hysteriaDown ? { brutalDown: String(s.hysteriaDown) + 'mbps' } : {}),
      });
    }
    if (s.hysteriaPorts)
      mask.udp = [
        ...(jsonArray(mask.udp) ? mask.udp : []),
        {
          type: 'udphop',
          settings: {
            mode: 'intervalRemote',
            remotePorts: String(s.hysteriaPorts),
            interval: String(s.hysteriaHopInterval),
          },
        },
      ];
    if (Object.keys(quic).length) mask.quicParams = quic;
  }
  if (
    s.fragmentEnabled &&
    ['tls', 'reality'].includes(String(s.security)) &&
    tcpTransports.includes(String(s.network))
  ) {
    const tcp = jsonArray(mask.tcp) ? mask.tcp : [];
    if (tcp.some((m) => jsonRecord(m) && m.type === 'fragment'))
      throw new Error('Remove the duplicate custom fragment mask or disable the named stage.');
    mask.tcp = [fragmentMask(s), ...tcp];
  }
  return mask;
}

// Synchronize edited transport JSON with the dedicated User-Agent field.
// A multivalue RAW header remains in JSON and is explicitly marked as overridden.
export function normalizeUserAgent(
  settings: Record<string, SettingValue>,
  preferredKey: string,
): { settings: Record<string, SettingValue>; found: boolean } {
  const s = { ...settings };
  let found = false;
  for (const key of [preferredKey]) {
    if (!s[key]) continue;
    try {
      const parsed: unknown = parseJson(String(s[key]));
      if (!jsonRecord(parsed)) continue;
      const object = parsed;
      const headers =
        key === 'rawHeader'
          ? jsonRecord(object.request)
            ? object.request.headers
            : undefined
          : key === 'xhttpExtra'
            ? object.headers
            : object;
      if (!jsonRecord(headers)) continue;
      const name = Object.keys(headers).find((k) => k.toLowerCase() === 'user-agent');
      if (!name) continue;
      const raw = headers[name],
        values = jsonArray(raw) ? raw : [raw];
      if (values.length === 1 && typeof values[0] === 'string') {
        s.userAgent = values[0];
        delete headers[name];
        s[key] = JSON.stringify(object);
      }
      // Explicit multivalue HTTP headers cannot fit the named scalar field.
      // Clear an inherited/named scalar so it cannot hide the edited JSON array.
      else if (jsonArray(raw)) s.userAgent = '';
      found = true;
    } catch {
      /* Preserve invalid drafts. */
    }
  }
  return { settings: s, found };
}
export function clearJsonUserAgents(
  settings: Record<string, SettingValue>,
): Record<string, SettingValue> {
  const s = { ...settings };
  for (const key of ['headers', 'rawHeader', 'xhttpExtra']) {
    try {
      if (!s[key]) continue;
      const parsed: unknown = parseJson(String(s[key]));
      if (!jsonRecord(parsed)) continue;
      const object = parsed;
      const headers =
        key === 'rawHeader'
          ? jsonRecord(object.request)
            ? object.request.headers
            : undefined
          : key === 'xhttpExtra'
            ? object.headers
            : object;
      if (!jsonRecord(headers)) continue;
      for (const name of Object.keys(headers))
        if (name.toLowerCase() === 'user-agent') delete headers[name];
      s[key] = JSON.stringify(object);
    } catch {
      /* Keep other draft JSON intact. */
    }
  }
  return s;
}

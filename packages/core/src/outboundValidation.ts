import { jsonRecord, parseJsonObject, parseJson } from './xrayJson';
import type { SettingValue } from './settings';

interface OutboundSettings {
  kind: string;
  settings: Record<string, SettingValue>;
}
interface OutboundProblem {
  fieldKey: string;
  message: string;
  severity: 'error' | 'warning';
}

const stringList = (value: SettingValue | undefined) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
function base64Bytes(value: string, url: boolean): number | null {
  if (
    url
      ? !/^[A-Za-z0-9_-]+$/.test(value)
      : !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return null;
  if (url && value.length % 4 === 1) return null;
  try {
    return atob(url ? value.replace(/-/g, '+').replace(/_/g, '/') : value).length;
  } catch {
    return null;
  }
}
export function validVlessId(value: string): boolean {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes >= 1 && bytes <= 30) return true;
  // Xray allows hyphens between any UUID byte groups, not only the canonical layout.
  if (bytes < 32 || bytes > 36) return false;
  let rest = value;
  for (const size of [8, 4, 4, 4, 12]) {
    if (rest.startsWith('-')) rest = rest.slice(1);
    if (!new RegExp(`^[0-9a-fA-F]{${size}}`).test(rest)) return false;
    rest = rest.slice(size);
  }
  return true;
}
export function validVlessEncryption(value: string): boolean {
  if (value === 'none') return true;
  const parts = value.split('.');
  return (
    parts.length >= 4 &&
    parts[0] === 'mlkem768x25519plus' &&
    ['native', 'xorpub', 'random'].includes(parts[1]) &&
    ['0rtt', '1rtt'].includes(parts[2]) &&
    parts
      .slice(3)
      .every((part) => part.length < 20 || [32, 1184].includes(base64Bytes(part, true) ?? -1))
  );
}

export function basicOutboundProblems(data: OutboundSettings): OutboundProblem[] {
  const s = data.settings;
  const issues: OutboundProblem[] = [];
  const add = (
    fieldKey: string,
    message: string,
    severity: OutboundProblem['severity'] = 'error',
  ) => issues.push({ fieldKey, message, severity });
  if (data.kind === 'vless-outbound' || data.kind === 'socks-outbound') {
    if (String(s.address).trim() && /\s|\/|\?|#|@/.test(String(s.address)))
      add('address', 'Enter only a server hostname or IP address, without a URL or path.');
    if (data.kind === 'socks-outbound' && s.auth === 'password') {
      if (new TextEncoder().encode(String(s.username)).length > 255)
        add('username', 'Username must fit in 255 UTF-8 bytes.');
      if (new TextEncoder().encode(String(s.password)).length > 255)
        add('password', 'Password must fit in 255 UTF-8 bytes.');
    }
    if (data.kind === 'socks-outbound' && s.muxEnabled)
      add(
        'muxEnabled',
        'Xray mux requires a compatible server, not a standard SOCKS service.',
        'warning',
      );
    if (s.id && !validVlessId(String(s.id)))
      add('id', 'Enter a UUID or a custom ID of 1–30 UTF-8 bytes.');
    if (s.encryption && !validVlessEncryption(String(s.encryption)))
      add('encryption', 'Use none or a valid mlkem768x25519plus encryption string.');
    if (s.security === 'reality') {
      if (!['raw', 'xhttp', 'grpc'].includes(String(s.network)))
        add('security', 'REALITY supports RAW, XHTTP and gRPC only.');
      if (s.realityPassword && base64Bytes(String(s.realityPassword), true) !== 32)
        add('realityPassword', 'Use a 32-byte unpadded Base64URL public key.');
      if (!/^(?:[0-9a-fA-F]{2}){0,8}$/.test(String(s.shortId)))
        add('shortId', 'Use up to 16 hexadecimal characters in byte pairs.');
      if (s.spiderX && !String(s.spiderX).startsWith('/'))
        add('spiderX', 'Start the spider path with /.');
      if (s.mldsa65Verify && base64Bytes(String(s.mldsa65Verify), true) !== 1952)
        add('mldsa65Verify', 'Use a 1,952-byte unpadded Base64URL verification key.');
      if (!String(s.serverName).trim())
        add('serverName', 'Set a server name allowed by the REALITY server.', 'warning');
    }
    if (
      s.flow &&
      s.encryption === 'none' &&
      (s.network !== 'raw' || !['tls', 'reality'].includes(String(s.security)))
    )
      add('flow', 'Vision without VLESS encryption needs RAW with TLS or REALITY.');
    if (
      s.flow &&
      s.security === 'tls' &&
      s.encryption === 'none' &&
      s.tlsMaxVersion &&
      s.tlsMaxVersion !== '1.3'
    )
      add('tlsMaxVersion', 'Vision requires TLS 1.3.');
    if (s.flow && s.muxEnabled && Number(s.muxConcurrency) >= 0)
      add('muxConcurrency', 'Disable TCP mux with -1 when using Vision; XUDP can remain enabled.');
    if (data.kind === 'vless-outbound' && s.security === 'none' && s.encryption === 'none')
      add(
        'security',
        'Current Xray permits unencrypted VLESS only to private addresses/domains. Verify that this endpoint is private.',
        'warning',
      );
    if (
      ['xhttp', 'ws', 'httpupgrade'].includes(String(s.network)) &&
      s.path &&
      !String(s.path).startsWith('/')
    )
      add('path', 'Start the HTTP path with /.');
    if (s.network === 'kcp' && Number(s.kcpWindow) < Number(s.kcpMtu))
      add('kcpWindow', 'The sending window must be at least the MTU.');
    if (s.network === 'hysteria' && s.security !== 'tls')
      add('security', 'Hysteria transport requires TLS.');
    if (s.security === 'tls') {
      if (s.tlsMinVersion && s.tlsMaxVersion && Number(s.tlsMinVersion) > Number(s.tlsMaxVersion))
        add('tlsMaxVersion', 'Maximum TLS version must be at least the minimum.');
      if (
        stringList(s.pinnedPeerCertSha256).some(
          (hash) => !/^[a-fA-F0-9]{64}$/.test(hash.replace(/:/g, '')),
        )
      )
        add('pinnedPeerCertSha256', 'Each certificate hash must contain 32 bytes of hexadecimal.');
    }
    if (s.network === 'ws' || s.network === 'httpupgrade') {
      try {
        const value: unknown = parseJson(String(s.headers || '{}'));
        const headers = jsonRecord(value) ? value : {};
        if (Object.values(headers).some((value) => typeof value !== 'string'))
          add('headers', 'Every HTTP header value must be a string.');
        if (Object.keys(headers).some((key) => key.toLowerCase() === 'host'))
          add('headers', 'Use the HTTP host field instead of a Host header.');
      } catch {
        /* Syntax diagnostics are provided by fieldProblem. */
      }
    }
    try {
      const reverse = s.reverse ? parseJsonObject(String(s.reverse)) : {};
      if (s.reverse && (typeof reverse.tag !== 'string' || !reverse.tag.trim()))
        add('reverse', 'Reverse settings need a nonempty tag.');
    } catch {
      /* Handled by fieldProblem. */
    }
    try {
      if (s.security === 'tls' && s.tlsExtra && parseJsonObject(String(s.tlsExtra)).allowInsecure)
        add(
          'tlsExtra',
          'allowInsecure was removed from current Xray. Use certificate pinning or verification names.',
        );
    } catch {
      /* Handled by fieldProblem. */
    }
  }
  if (
    data.kind === 'direct-outbound' &&
    s.redirect &&
    !/^(?:\[[0-9a-fA-F:.]+\]|[^\s:/]*):(?:[0-9]{1,5})$/.test(String(s.redirect))
  )
    add('redirect', 'Use host:port, [IPv6]:port, or :port.');
  if (data.kind === 'direct-outbound' && s.redirect) {
    const port = Number(String(s.redirect).split(':').at(-1));
    if (port < 1 || port > 65535) add('redirect', 'Destination override port must be 1–65535.');
  }
  if (
    data.kind === 'block-outbound' &&
    s.response === 'custom' &&
    s.customResponseData &&
    base64Bytes(String(s.customResponseData), false) === null
  )
    add('customResponseData', 'Enter standard Base64 response bytes.');
  return issues;
}

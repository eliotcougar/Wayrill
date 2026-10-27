import { httpProxyInputs } from './graph/proxy';
import type { RuntimeCompilation } from './graph/runtime';
export type CaptureChannel =
  'wininet' | 'envUser' | 'envMachine' | 'winhttpLegacy' | 'winhttpMachine' | 'winhttpUser';
export interface ProxyInput {
  tag: string;
  label: string;
  port: number;
  http: boolean;
  socks: boolean;
  applied?: boolean;
}
export interface CaptureRequest {
  channel: CaptureChannel;
  expectedVersion: string;
  mode: 'proxy' | 'automatic';
  inputTag: string;
  allInputTag: string;
  allProtocol: 'http' | 'socks5' | 'socks5h';
  http: boolean;
  https: boolean;
  ftp: boolean;
  all: boolean;
  bypass: string;
  pacUrl: string;
  autoDetect: boolean;
}
export interface CaptureSettingsRow {
  channel: CaptureChannel;
  supported: boolean;
  advancedSupported?: boolean;
  scope?: 'user' | 'machine';
  scopeConflict?: boolean;
  scopeSwitchSupported?: boolean;
  version: string;
  managed: boolean;
  conflict?: boolean;
  values: Record<string, string | boolean | null>;
  expandVariables?: string[];
  request?: CaptureRequest | null;
  error?: { message: string };
}
export interface DriverState {
  registered: boolean;
  state: string;
  owned: boolean;
  version: string;
}
export interface SystemCaptureSnapshot {
  rows: CaptureSettingsRow[];
  inputs: ProxyInput[];
  revision: number;
  running: boolean;
  capture: {
    state: string;
    inputs: string[];
    availability?: { state: string; message: string | null };
  };
  captureInputs: string[];
  driver: DriverState;
}
/** Show edited endpoints, but only the exact applied tag/port can receive traffic. */
export function captureProxyInputs(
  compiled: RuntimeCompilation | null,
  applied: ProxyInput[],
): ProxyInput[] {
  if (!compiled) return applied.map((i) => ({ ...i, applied: true }));
  return httpProxyInputs(compiled.config, compiled.capture).map((i) => ({
    tag: String(i.tag),
    port: Number(i.port),
    label: compiled.displayNames?.inbound[String(i.tag)] ?? String(i.tag),
    http: true,
    socks: ['socks', 'mixed'].includes(String(i.protocol)),
    applied: applied.some(
      (a) =>
        a.tag === i.tag &&
        a.port === i.port &&
        a.socks === ['socks', 'mixed'].includes(String(i.protocol)),
    ),
  }));
}
export function initialCaptureRequest(
  channel: CaptureChannel,
  row: CaptureSettingsRow | undefined,
  inputs: ProxyInput[],
): CaptureRequest {
  const http = inputs.find((i) => i.applied && i.http) ?? inputs.find((i) => i.http);
  const all = inputs.find((i) => i.applied && i.socks) ?? inputs.find((i) => i.socks);
  const environment = channel === 'envUser' || channel === 'envMachine';
  return {
    channel,
    mode: 'proxy',
    inputTag: http?.tag ?? '',
    allInputTag: all?.tag ?? '',
    allProtocol: 'socks5h',
    http: true,
    https: true,
    ftp: false,
    all: false,
    bypass: environment ? 'localhost,127.0.0.1,::1' : '<local>;localhost;127.*;[::1]',
    pacUrl: '',
    autoDetect: false,
    ...(row?.request ?? {}),
    expectedVersion: row?.version ?? '',
  };
}
export function requestIssue(
  request: CaptureRequest,
  inputs: ProxyInput[],
  running: boolean,
  advanced: boolean,
): string {
  if (request.mode === 'automatic') {
    if (!advanced) return 'Advanced proxy settings are unavailable on this Windows version.';
    if (!request.autoDetect && !request.pacUrl)
      return 'Enter a PAC URL or enable automatic discovery.';
    if (request.pacUrl) {
      try {
        const url = new URL(request.pacUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
          return 'Use an HTTP/HTTPS PAC URL without credentials or a fragment.';
      } catch {
        return 'Enter a valid PAC URL.';
      }
    }
    return '';
  }
  const environment = request.channel === 'envUser' || request.channel === 'envMachine';
  if (environment && !request.http && !request.https && !request.ftp && !request.all)
    return 'Select at least one proxy variable.';
  const input = inputs.find((i) => i.tag === request.inputTag);
  const needsHttp = !environment || request.http || request.https || request.ftp;
  const all = inputs.find((i) => i.tag === request.allInputTag);
  if (
    (needsHttp && (!input?.http || !input.applied)) ||
    (environment &&
      request.all &&
      (!all?.applied || (request.allProtocol !== 'http' && !all.socks)))
  )
    return 'Apply the selected graph input first.';
  if (!running) return 'Start the applied graph before pointing Windows to it.';
  return '';
}
/** Recreate the logged-on user's merged environment, regardless of the tab selected. */
export function environmentCommands(rows: CaptureSettingsRow[]): string {
  const user = rows.find((r) => r.channel === 'envUser');
  const machine = rows.find((r) => r.channel === 'envMachine');
  if (!user?.supported || !machine?.supported) return '';
  const lines = ['# Run in the PowerShell session that needs these settings.'];
  for (const name of ['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy']) {
    const source = typeof user.values[name] === 'string' ? user : machine;
    const value = source.values[name];
    const literal = typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : '';
    const expression = source.expandVariables?.includes(name)
      ? `[Environment]::ExpandEnvironmentVariables(${literal})`
      : literal;
    lines.push(
      typeof value === 'string'
        ? `$env:${name} = ${expression}`
        : `Remove-Item Env:${name} -ErrorAction SilentlyContinue`,
    );
  }
  return lines.join('\n');
}

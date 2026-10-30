import { jsonArray, jsonRecord, jsonText } from './xrayJson';
import { nativeValue, setNative } from './protocols';
import type { RuleNodeData } from './types';

export const udpBufferFields = {
  udpReceiveBufferKiB: 'receive',
  udpSendBufferKiB: 'send',
} as const;

/** Lift the old app-generated options into named defaults without touching native extras. */
export function migrateUdpBufferDefaults(input: RuleNodeData['settings']) {
  const settings = { ...input };
  if (!settings.sockoptExtra) return settings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(settings.sockoptExtra));
  } catch {
    return settings;
  }
  if (!jsonRecord(parsed)) return settings;
  let socket: Record<string, unknown> = parsed;
  let changed = false;
  for (const [key, buffer] of Object.entries(udpBufferFields)) {
    if (Object.hasOwn(settings, key)) continue;
    const rows = options(socket);
    const managed = rows.filter(
      (row) =>
        matches(row, buffer) &&
        nativeValue(row, 'system') === 'windows' &&
        nativeValue(row, 'network') === 'udp',
    );
    if (!managed.length || rows.some((row) => matches(row, buffer) && !managed.includes(row)))
      continue;
    const bytes = socketBufferValue(socket, 'udp', buffer).value;
    if (!bytes || bytes % 1024 || bytes > 64 * 1024 * 1024) continue;
    settings[key] = bytes / 1024;
    socket = setSocketBuffer(socket, 'udp', buffer, undefined);
    changed = true;
  }
  if (changed) settings.sockoptExtra = Object.keys(socket).length ? JSON.stringify(socket) : '';
  return settings;
}

/** Named sizes compile to stock Xray socket options; preserve explicit native options. */
export function applyUdpBufferSettings(sockopt: Record<string, unknown>, data: RuleNodeData) {
  let result = sockopt;
  for (const [key, buffer] of Object.entries(udpBufferFields)) {
    const value = data.settings[key];
    const reset = data.native?.overrideKeys?.includes(key) && !data.overrides?.includes(key);
    if ((value === undefined || value === '' || data.coreDefaults?.includes(key)) && !reset)
      continue;
    const explicit =
      reset || data.overrides?.includes(key) || data.native?.editedKeys?.includes(key);
    if (!explicit && socketBufferValue(result, 'udp', buffer).families.some((v) => v !== undefined))
      continue;
    if (explicit) {
      // A named override covers both UDP families. Keep a wildcard option's
      // TCP effect when removing its UDP effect, including a reset to Windows.
      const remaining = options(result).flatMap((option) => {
        if (!matches(option, buffer)) return [option];
        const network = jsonText(nativeValue(option, 'network'));
        if (!network) return [setNative(option, 'network', 'tcp')];
        return /^udp[46]?$/.test(network) ? [] : [option];
      });
      result = setNative(result, 'customSockopt', remaining.length ? remaining : undefined);
    }
    result = setSocketBuffer(result, 'udp', buffer, !value ? undefined : Number(value) * 1024);
  }
  return result;
}

import type { SocketNetwork } from './listenerNetworks';
export type SocketBuffer = 'receive' | 'send';
const optionNumbers = { receive: '4098', send: '4097' } as const;

const options = (sockopt: Record<string, unknown>) => {
  const value = nativeValue(sockopt, 'customSockopt');
  return jsonArray(value) ? value : [];
};
function matches(option: unknown, buffer: SocketBuffer): option is Record<string, unknown> {
  if (!jsonRecord(option)) return false;
  return (
    ['', 'windows'].includes(jsonText(nativeValue(option, 'system'))) &&
    jsonText(nativeValue(option, 'level')) === '65535' &&
    jsonText(nativeValue(option, 'opt')) === optionNumbers[buffer] &&
    nativeValue(option, 'type') === 'int'
  );
}
export function socketBufferValue(
  sockopt: Record<string, unknown>,
  network: SocketNetwork,
  buffer: SocketBuffer,
) {
  const families = ['4', '6'].map((family) => {
    let result: number | undefined;
    for (const option of options(sockopt)) {
      if (
        !matches(option, buffer) ||
        !(network + family).startsWith(jsonText(nativeValue(option, 'network')))
      )
        continue;
      const text = jsonText(nativeValue(option, 'value'));
      const value = /^[+]?\d+$/.test(text) ? Number(text) : NaN;
      result = Number.isInteger(value) && value > 0 && value <= 2147483647 ? value : undefined;
    }
    return result;
  });
  return { value: families[0] === families[1] ? families[0] : undefined, families };
}

/** Replace only this Windows-wide option; preserve wildcard, per-family and foreign options. */
export function setSocketBuffer(
  sockopt: Record<string, unknown>,
  network: SocketNetwork,
  buffer: SocketBuffer,
  value: number | undefined,
) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 2147483647))
    throw new Error('Use 1–2147483647 bytes.');
  const next = options(sockopt).filter(
    (option) =>
      !(
        matches(option, buffer) &&
        nativeValue(option, 'system') === 'windows' &&
        nativeValue(option, 'network') === network
      ),
  );
  if (value !== undefined)
    next.push({
      system: 'windows',
      network,
      level: '65535',
      opt: optionNumbers[buffer],
      value: String(value),
      type: 'int',
    });
  return setNative(sockopt, 'customSockopt', next.length ? next : undefined);
}

import { jsonArray, jsonRecord, jsonText } from './xrayJson';
import { nativeValue, setNative } from './protocols';

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

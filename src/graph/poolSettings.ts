import { globalFields } from './defaults';
import { fieldProblem } from './settingValidation';
import { jsonRecord } from './xrayJson';

export const poolSettingKeys = [
  'routingDomainStrategy',
  'logLevel',
  'udpListenerReceiveKiB',
  'udpListenerSendKiB',
] as const;
export type PoolSettingKey = (typeof poolSettingKeys)[number];
export type PoolSettings = Partial<Record<PoolSettingKey, string | number>>;
export const isPoolSettingKey = (key: string): key is PoolSettingKey =>
  poolSettingKeys.some((allowed) => allowed === key);

export function parsePoolSettings(value: unknown): PoolSettings | undefined {
  if (value === undefined) return undefined;
  if (!jsonRecord(value)) throw new Error('Invalid Pool settings.');
  for (const key of Object.keys(value)) {
    if (!isPoolSettingKey(key)) throw new Error('This setting cannot be managed by a Pool.');
    const field = globalFields.find((item) => item.key === key)!;
    const setting = value[key];
    const problem =
      typeof setting === 'number' || typeof setting === 'string'
        ? fieldProblem(field, { [key]: setting })
        : 'Invalid value.';
    if (problem) throw new Error(`Pool settings: ${field.label} — ${problem}`);
  }
  return Object.keys(value).length ? value : undefined;
}

export function formatPoolSetting(key: PoolSettingKey, value: string | number) {
  if (key === 'udpListenerReceiveKiB' || key === 'udpListenerSendKiB')
    return value === 0 ? 'Windows default (0 KiB)' : `${value} KiB`;
  return String(value);
}

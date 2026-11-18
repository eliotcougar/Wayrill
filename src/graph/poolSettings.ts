import { globalFields } from './defaults';
import {
  packagedResources,
  poolResourceKinds,
  readGraphResources,
  validResourceFilename,
} from './resources';
import { fieldProblem } from './settingValidation';
import type { GraphState } from './types';
import { jsonRecord } from './xrayJson';

export const poolSettingKeys = [
  'routingDomainStrategy',
  'logLevel',
  'udpListenerReceiveKiB',
  'udpListenerSendKiB',
  'geoSiteFile',
  'geoIpFile',
] as const;
export type PoolSettingKey = (typeof poolSettingKeys)[number];
export type PoolSettings = Partial<Record<PoolSettingKey, string | number>>;
export type PoolResourceKey = keyof typeof poolResourceKinds;
export const isPoolResourceKey = (key: PoolSettingKey): key is PoolResourceKey =>
  Object.hasOwn(poolResourceKinds, key);
export const isPoolSettingKey = (key: string): key is PoolSettingKey =>
  poolSettingKeys.some((allowed) => allowed === key);
export function parseLocalPoolSettings(value: unknown) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > poolSettingKeys.length ||
    !value.every((key) => typeof key === 'string' && isPoolSettingKey(key))
  )
    throw new Error('Invalid personal Pool settings.');
  const keys = poolSettingKeys.filter((key) => value.includes(key));
  return keys.length ? keys : undefined;
}
export const poolResourceLabel = (key: PoolResourceKey) =>
  key === 'geoSiteFile' ? 'Default GeoSite file' : 'Default GeoIP file';

export function poolResourceProblem(key: PoolResourceKey, value: unknown): string | null {
  if (typeof value !== 'string' || !validResourceFilename(value))
    return 'Enter a DAT filename such as ru-geosite.dat.';
  const file = packagedResources.find((file) => file.name === value.toLowerCase());
  if (file && file.kind !== poolResourceKinds[key]) return 'Choose a file of the matching type.';
  return null;
}

export function poolResourceSettings(graph: GraphState): PoolSettings | undefined {
  const settings: PoolSettings = {};
  for (const { kind, name, enabled } of readGraphResources(graph).files) {
    if (enabled) settings[kind === 'geosite' ? 'geoSiteFile' : 'geoIpFile'] = name;
  }
  return Object.keys(settings).length ? settings : undefined;
}

export function parsePoolSettings(value: unknown): PoolSettings | undefined {
  if (value === undefined) return undefined;
  if (!jsonRecord(value)) throw new Error('Invalid Pool settings.');
  const received = Object.keys(value);
  if (!received.every(isPoolSettingKey))
    throw new Error('This setting cannot be managed by a Pool.');
  for (const key of poolSettingKeys) {
    if (!received.includes(key)) continue;
    if (isPoolResourceKey(key)) {
      const problem = poolResourceProblem(key, value[key]);
      if (problem) throw new Error(`Pool settings: ${poolResourceLabel(key)} — ${problem}`);
      continue;
    }
    const field = globalFields.find((item) => item.key === key)!;
    const setting = value[key];
    const problem =
      typeof setting === 'number' || typeof setting === 'string'
        ? fieldProblem(field, { [key]: setting })
        : 'Invalid value.';
    if (problem) throw new Error(`Pool settings: ${field.label} — ${problem}`);
  }
  if (
    typeof value.geoSiteFile === 'string' &&
    typeof value.geoIpFile === 'string' &&
    value.geoSiteFile.toLowerCase() === value.geoIpFile.toLowerCase()
  )
    throw new Error('Pool settings: Choose different GeoSite and GeoIP files.');
  return received.length ? value : undefined;
}

export function formatPoolSetting(key: PoolSettingKey, value: string | number) {
  if (key === 'udpListenerReceiveKiB' || key === 'udpListenerSendKiB')
    return value === 0 ? 'Windows default (0 KiB)' : `${value} KiB`;
  return String(value);
}

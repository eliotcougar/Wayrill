import { jsonRecord } from '../graph/xrayJson';
import type { ProtectionConfig } from '../components/AppProtectionSettings';

export type DeviceLayerData =
  | { kind: 'loopback'; packages: string[] }
  | { kind: 'app-protection'; protection: ProtectionConfig };
export type DeviceSettings = { loopback: string[]; protection: ProtectionConfig };

export const isDeviceLayer = (data: { kind: string }): data is DeviceLayerData =>
  data.kind === 'loopback' || data.kind === 'app-protection';

export const packageFamily = (value: string) => /^[a-z0-9.-]{3,50}_[a-z0-9]{13}$/i.test(value);
const executablePath = (value: string) =>
  /^[a-z]:\\[^*?"/]+\.exe$/i.test(value) &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
  !value.split('\\').some((part) => part === '.' || part === '..') &&
  new TextEncoder().encode(value).length <= 32767;

function unique<T>(values: T[], key: (value: T) => string) {
  return [...new Map(values.map((value) => [key(value).toLowerCase(), value])).values()];
}

export function readDeviceLayer(data: unknown): DeviceLayerData {
  if (jsonRecord(data) && data.kind === 'loopback') {
    const packages: unknown = data.packages;
    if (
      !Array.isArray(packages) ||
      packages.length > 256 ||
      !packages.every(
        (family): family is string => typeof family === 'string' && packageFamily(family),
      )
    )
      throw new Error('Use up to 256 exact Windows package family names.');
    return { kind: 'loopback', packages: unique(packages, (family) => family) };
  }
  if (jsonRecord(data) && data.kind === 'app-protection' && jsonRecord(data.protection)) {
    const { protection } = data;
    if (
      typeof protection.enabled !== 'boolean' ||
      !Array.isArray(protection.applications) ||
      protection.applications.length > 256 ||
      (protection.enabled && !protection.applications.length)
    )
      throw new Error('An enabled App protection layer needs 1 to 256 applications.');
    const applications = protection.applications.map(
      (row): ProtectionConfig['applications'][number] => {
        if (
          !jsonRecord(row) ||
          typeof row.value !== 'string' ||
          !(row.kind === 'package'
            ? packageFamily(row.value)
            : row.kind === 'executable' && executablePath(row.value))
        )
          throw new Error('Enter a full Windows executable path or exact package family name.');
        return { kind: row.kind as 'package' | 'executable', value: row.value };
      },
    );
    return {
      kind: 'app-protection',
      protection: {
        enabled: protection.enabled,
        applications: unique(applications, (app) => `${app.kind}:${app.value}`),
      },
    };
  }
  throw new Error('Invalid Pool Windows settings layer.');
}

export function combineDeviceLayers(layers: DeviceLayerData[]): DeviceSettings {
  const loopback = unique(
    layers.flatMap((layer) => (layer.kind === 'loopback' ? layer.packages : [])),
    (family) => family,
  );
  const applications = unique(
    layers.flatMap((layer) =>
      layer.kind === 'app-protection' && layer.protection.enabled
        ? layer.protection.applications
        : [],
    ),
    (app) => `${app.kind}:${app.value}`,
  );
  if (loopback.length > 256 || applications.length > 256)
    throw new Error(
      'Select at most 256 loopback packages and 256 protected applications in total.',
    );
  return { loopback, protection: { enabled: applications.length > 0, applications } };
}

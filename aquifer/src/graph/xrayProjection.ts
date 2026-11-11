import { parseXrayMetadata as parseMetadata } from '@wayrill/core/nativeProjection';
export { parseNativeProjection, forceProjectionFields } from '@wayrill/core/nativeProjection';
import { LIMITS } from '../limits';
import { effectiveDefaults } from './defaults';
import { parseJson } from './xrayJson';
import type { GlobalDefaults } from './types';
export function coreProjection(defaults: GlobalDefaults): Record<string, unknown> {
  const d = effectiveDefaults(defaults);
  const configured = (key: string) => Object.hasOwn(defaults.settings, key);
  return {
    log: {
      ...(configured('logLevel') ? { loglevel: d.logLevel } : {}),
      ...(configured('dnsLog') ? { dnsLog: d.dnsLog } : {}),
      ...(configured('maskAddress') ? { maskAddress: d.maskAddress } : {}),
    },
    routing: {
      ...(configured('routingDomainStrategy') ? { domainStrategy: d.routingDomainStrategy } : {}),
    },
    ...(d.policy ? { policy: parseJson(String(d.policy)) } : {}),
    ...(d.statistics ? { stats: {} } : {}),
    ...(d.metricsEnabled
      ? {
          metrics: {
            ...(d.metricsTag ? { tag: d.metricsTag } : {}),
            ...(d.metricsListen ? { listen: d.metricsListen } : {}),
          },
        }
      : {}),
  };
}

export const parseXrayMetadata = (raw: unknown) => parseMetadata(raw, LIMITS.maxOutbounds);

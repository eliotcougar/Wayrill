import { LIMITS } from '../limits';
import { effectiveDefaults } from './defaults';
import { udpListenerEnvironment } from './udpListeners';
import { checkJson, cloneJson, jsonRecord, jsonArray, parseJson } from './xrayJson';
import type { GlobalDefaults, NativeProjection, XrayGraphMetadata } from './types';
export function coreProjection(defaults: GlobalDefaults): Record<string, unknown> {
  const d = effectiveDefaults(defaults);
  const configured = (key: string) => Object.hasOwn(defaults.settings, key);
  return {
    ...(Object.keys(udpListenerEnvironment(defaults)).length
      ? { env: udpListenerEnvironment(defaults) }
      : {}),
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
export function parseNativeProjection(raw: unknown): NativeProjection {
  if (
    !jsonRecord(raw) ||
    raw.version !== 1 ||
    !jsonRecord(raw.original) ||
    !jsonRecord(raw.projection) ||
    Object.keys(raw).some(
      (k) => !['version', 'original', 'projection', 'overrideKeys', 'editedKeys'].includes(k),
    )
  )
    throw new Error('Invalid native Xray projection.');
  for (const keys of [raw.overrideKeys, raw.editedKeys])
    if (
      keys !== undefined &&
      (!jsonArray(keys) ||
        keys.length > 128 ||
        keys.some((k) => typeof k !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)) ||
        new Set(keys).size !== keys.length)
    )
      throw new Error('Invalid native inheritance baseline.');
  checkJson(raw);
  return cloneJson(raw) as unknown as NativeProjection;
}

// An explicit "Use default" is an edit even if the visual value equals the
// import-time placeholder. Materialize its active core fields instead of
// silently retaining a native omission with a different core default.
export function forceProjectionFields(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  const result = cloneJson(original);
  for (const path of paths) {
    const parts = path
      .slice(1)
      .split('/')
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target: Record<string, unknown> = result,
      source: unknown = current;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i],
        spellings = Object.keys(target).filter((k) => k.toLowerCase() === key.toLowerCase());
      if (spellings.length > 1) throw new Error('Conflicting native field spellings.');
      const actual = spellings[0] ?? key,
        next = jsonRecord(source) ? source[key] : undefined;
      if (i === parts.length - 1 || next === undefined) {
        if (next === undefined) delete target[actual];
        else target[actual] = cloneJson(next);
        break;
      }
      if (jsonArray(next)) {
        target[actual] = cloneJson(next);
        break;
      }
      if (!jsonRecord(target[actual])) target[actual] = {};
      target = target[actual] as Record<string, unknown>;
      source = next;
    }
  }
  return result;
}
export function parseXrayMetadata(raw: unknown): XrayGraphMetadata {
  if (!jsonRecord(raw) || raw.version !== 1)
    throw new Error('Invalid imported Xray graph metadata.');
  const keys = [
    'version',
    'optionsNodeId',
    'routingNodeId',
    'dnsNodeId',
    'inboundOrder',
    'outboundOrder',
    'outboundPool',
    'balancerOrder',
    'inboundsPresent',
    'outboundsPresent',
    'routingPresent',
    'rulesPresent',
    'balancersPresent',
    'dnsServersPresent',
    'defaultsProjection',
  ];
  if (Object.keys(raw).some((k) => !keys.includes(k)))
    throw new Error('Unknown imported Xray graph metadata.');
  const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
  if (
    !id(raw.optionsNodeId) ||
    !id(raw.routingNodeId) ||
    (raw.dnsNodeId !== undefined && !id(raw.dnsNodeId)) ||
    !jsonRecord(raw.defaultsProjection)
  )
    throw new Error('Invalid imported Xray graph references.');
  for (const key of ['inboundOrder', 'outboundOrder', 'balancerOrder']) {
    const list = raw[key];
    if (
      !jsonArray(list) ||
      list.length > (key === 'outboundOrder' ? LIMITS.maxOutbounds : 500) ||
      list.some((v) => !id(v)) ||
      new Set(list).size !== list.length
    )
      throw new Error('Invalid native configuration order.');
  }
  if (raw.outboundPool !== undefined) {
    if (!jsonArray(raw.outboundPool) || raw.outboundPool.length > LIMITS.maxOutbounds)
      throw new Error('Invalid imported internal outbound pool.');
    const ids = new Set<string>();
    const ordered = new Set(raw.outboundOrder as unknown[]);
    for (const entry of raw.outboundPool) {
      if (
        !jsonRecord(entry) ||
        !id(entry.id) ||
        ids.has(String(entry.id)) ||
        !jsonRecord(entry.config) ||
        Object.keys(entry).some((k) => !['id', 'config'].includes(k)) ||
        !ordered.has(entry.id)
      )
        throw new Error('Invalid imported internal outbound reference.');
      ids.add(String(entry.id));
    }
  }
  for (const key of [
    'inboundsPresent',
    'outboundsPresent',
    'routingPresent',
    'rulesPresent',
    'balancersPresent',
    'dnsServersPresent',
  ])
    if (typeof raw[key] !== 'boolean') throw new Error('Invalid native section presence marker.');
  checkJson(raw);
  return cloneJson(raw) as unknown as XrayGraphMetadata;
}

import { checkJson, checkJsonProperty, cloneJson, jsonRecord, jsonArray } from './xrayJson';

export interface NativeProjection {
  version: 1;
  original: Record<string, unknown>;
  projection: Record<string, unknown>;
  overrideKeys?: string[];
  // Explicit shared-field edits, including values equal to import placeholders.
  editedKeys?: string[];
}
export interface XrayGraphMetadata {
  version: 1;
  optionsNodeId: string;
  routingNodeId: string;
  dnsNodeId?: string;
  inboundOrder: string[];
  outboundOrder: string[];
  outboundPool?: { id: string; config: Record<string, unknown> }[];
  balancerOrder: string[];
  inboundsPresent: boolean;
  outboundsPresent: boolean;
  routingPresent: boolean;
  rulesPresent: boolean;
  balancersPresent: boolean;
  dnsServersPresent: boolean;
  defaultsProjection: Record<string, unknown>;
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

function materializeField(
  target: Record<string, unknown>,
  source: unknown,
  parts: string[],
  index: number,
): Record<string, unknown> {
  const key = parts[index];
  checkJsonProperty(key);
  const spellings = Object.keys(target).filter((name) => name.toLowerCase() === key.toLowerCase());
  if (spellings.length > 1) throw new Error('Conflicting native field spellings.');
  const actual = spellings[0] ?? key;
  const next = jsonRecord(source) && Object.hasOwn(source, key) ? source[key] : undefined;
  if (next === undefined)
    return Object.fromEntries(Object.entries(target).filter(([name]) => name !== actual));
  const existing = spellings.length ? target[actual] : undefined;
  const value =
    index === parts.length - 1 || jsonArray(next)
      ? cloneJson(next)
      : materializeField(jsonRecord(existing) ? existing : {}, next, parts, index + 1);
  return { ...target, [actual]: value };
}

// An explicit "Use default" is an edit even if the visual value equals the
// import-time placeholder. Materialize its active core fields instead of
// silently retaining a native omission with a different core default.
export function forceProjectionFields(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  let result = cloneJson(original);
  for (const path of paths) {
    const parts = path
      .slice(1)
      .split('/')
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    result = materializeField(result, current, parts, 0);
  }
  return result;
}
export function parseXrayMetadata(raw: unknown, maxOutbounds: number): XrayGraphMetadata {
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
      list.length > (key === 'outboundOrder' ? maxOutbounds : 500) ||
      list.some((v) => !id(v)) ||
      new Set(list).size !== list.length
    )
      throw new Error('Invalid native configuration order.');
  }
  if (raw.outboundPool !== undefined) {
    if (!jsonArray(raw.outboundPool) || raw.outboundPool.length > maxOutbounds)
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

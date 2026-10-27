import type { Diagnostic, NodeDefinition, RuleNode, RuleNodeData } from './types';
import {
  checkJson,
  jsonRecord,
  patchProjection,
  jsonText,
  jsonArray,
  parseJson,
  parseJsonArray,
} from './xrayJson';
import { isExecutableOutboundKind } from './outbounds';
import {
  dnsHandlerFields,
  dnsServerFields,
  metricsFields,
  nativeFieldText,
  nativeFieldValue,
  policyLevelFields,
  policySystemFields,
} from './nativeFields';
export const nativeXrayKinds = [
  'xray-inbound',
  'xray-outbound',
  'xray-options',
  'xray-dns',
  'xray-dns-servers',
] as const;
export const isNativeXrayKind = (kind: string): kind is (typeof nativeXrayKinds)[number] =>
  (nativeXrayKinds as readonly string[]).includes(kind);
export const isNativeConfigEditor = (kind: string) =>
  ['xray-options', 'xray-dns', 'xray-dns-servers'].includes(kind);
export const isXrayOutbound = (n: RuleNode) =>
  isExecutableOutboundKind(n.data.kind) || n.data.kind === 'xray-outbound';
export function nativeJson(data: RuleNodeData): Record<string, unknown> {
  const value: unknown = parseJson(String(data.settings.json));
  checkJson(value);
  if (!jsonRecord(value)) throw new Error('Native Xray options must be a JSON object.');
  return value;
}
export function nativeConfig(data: RuleNodeData): Record<string, unknown> {
  const json = nativeJson(data);
  if (Object.keys(json).some((k) => k.toLowerCase() === 'tag'))
    throw new Error('Use the Tag field rather than adding tag to native options.');
  const current = { ...json, ...(data.settings.tag ? { tag: String(data.settings.tag) } : {}) };
  return data.native
    ? (patchProjection(data.native.original, data.native.projection, current) as Record<
        string,
        unknown
      >)
    : current;
}
export function nativeOutputs(data: RuleNodeData): { id: string; name: string }[] {
  try {
    if (data.kind === 'xray-inbound') return [{ id: 'traffic', name: 'All traffic' }];
    if (data.kind === 'xray-dns') {
      const value: unknown = parseJson(String(data.settings.outputs));
      const ids = new Set<string>();
      if (!jsonArray(value) || value.length > 128)
        throw new Error('Use at most 128 resolver outputs.');
      for (const o of value) {
        if (
          !jsonRecord(o) ||
          typeof o.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(o.id) ||
          ids.has(o.id) ||
          typeof o.name !== 'string' ||
          !o.name.trim() ||
          o.name.length > 128
        )
          throw new Error('Invalid resolver outputs.');
        ids.add(o.id);
      }
      return value as { id: string; name: string }[];
    }
    if (data.kind === 'xray-dns-servers') {
      const servers = nativeJson(data).servers;
      return jsonArray(servers) &&
        servers.some((s) => {
          const a = jsonRecord(s) ? s.address : s;
          return (
            typeof a === 'string' &&
            a !== 'localhost' &&
            a.toLowerCase() !== 'fakedns' &&
            !/^(?:tcp|https|quic)\+local:\/\//i.test(a)
          );
        })
        ? [{ id: 'queries', name: 'Native query routing' }]
        : [];
    }
  } catch {
    /* Field diagnostics report invalid drafts. */
  }
  return [];
}
const tagField = { key: 'tag', label: 'Tag', type: 'text' as const, maxLength: 4096 };
const jsonField = {
  key: 'json',
  label: 'Native Xray options (JSON)',
  type: 'json' as const,
  jsonShape: 'object' as const,
  maxLength: 524288,
  help: 'All native fields are preserved. This editor includes settings without a dedicated visual control; Xray performs complete configuration validation.',
};
export const xrayDefinitions: NodeDefinition[] = [
  {
    kind: 'xray-inbound',
    title: 'Xray input',
    category: 'inbound',
    group: 'Inbounds',
    summary: 'Native listener; sends all traffic through the ordered global rules',
    defaults: {
      tag: 'native-input',
      json: '{"protocol":"mixed","listen":"127.0.0.1","port":2080,"settings":{"auth":"noauth","udp":true}}',
    },
    fields: [tagField, jsonField],
  },
  {
    kind: 'xray-outbound',
    title: 'Xray outbound',
    category: 'outbound',
    group: 'Outbounds',
    summary: 'Native protocol or settings without a dedicated visual editor',
    defaults: { tag: 'native-outbound', json: '{"protocol":"freedom"}' },
    fields: [tagField, jsonField],
  },
  {
    kind: 'xray-options',
    title: 'Xray core options',
    category: 'rule',
    group: 'Rules & filters',
    summary: 'Preserved logging, policy, metrics, statistics and native root options',
    defaults: { json: '{}' },
    fields: [
      {
        ...jsonField,
        help: 'Root sections excluding inbounds, outbounds, DNS and observatories. routing may contain options but not rules or balancers. Global defaults edits are applied to the mapped core fields.',
      },
    ],
  },
  {
    kind: 'xray-dns',
    title: 'Xray DNS handler',
    category: 'rule',
    group: 'Rules & filters',
    summary: 'Global DNS settings and ordered resolver connections',
    defaults: { json: '{}', outputs: '[]' },
    fields: [
      {
        ...jsonField,
        help: 'Global DNS options excluding servers; resolver outputs below assemble the native server list in that exact order.',
      },
      {
        key: 'outputs',
        label: 'Ordered resolver outputs (JSON)',
        type: 'json',
        jsonShape: 'array',
        maxLength: 65536,
      },
    ],
  },
  {
    kind: 'xray-dns-servers',
    title: 'Xray DNS server(s)',
    category: 'outbound',
    group: 'Outbounds',
    summary: 'Native servers, domain preferences, answer checks and fallback flags',
    defaults: { json: '{"servers":["1.1.1.1"]}' },
    fields: [
      {
        ...jsonField,
        help: 'servers contains one or more native string/object entries. domains, expectedIPs, skipFallback, finalQuery, tags and extended fields retain Xray resolver semantics. Local transports bypass query routing.',
      },
    ],
  },
];
export function nativeSummary(data: RuleNodeData): [string, string][] {
  try {
    const j = nativeJson(data);
    if (data.kind === 'xray-inbound')
      return [
        ['Protocol', jsonText(j.protocol ?? '')],
        ['Listen', `${jsonText(j.listen ?? '')}:${jsonText(j.port ?? '')}`],
      ];
    if (data.kind === 'xray-outbound')
      return [
        ['Protocol', jsonText(j.protocol ?? '')],
        ['Tag', String(data.settings.tag || '(untagged)')],
      ];
    if (data.kind === 'xray-dns') return [];
    if (data.kind === 'xray-dns-servers')
      return [
        ['Servers', String(jsonArray(j.servers) ? j.servers.length : 0)],
        ['Preferences', 'Native domain / fallback rules'],
      ];
    return [
      ['Sections', Object.keys(j).join(', ') || 'Core defaults'],
      ['Mode', 'Imported native configuration'],
    ];
  } catch {
    return [['JSON', 'Invalid draft']];
  }
}
export function nativeProblems(data: RuleNodeData): Diagnostic[] {
  if (!isNativeXrayKind(data.kind)) return [];
  try {
    const j = nativeJson(data);
    if (['xray-inbound', 'xray-outbound'].includes(data.kind)) nativeConfig(data);
    if (
      data.kind === 'xray-dns' &&
      (Object.hasOwn(j, 'servers') ||
        nativeOutputs(data).length !== parseJsonArray(String(data.settings.outputs)).length)
    )
      throw new Error('Keep servers in connected resolver nodes and use valid ordered outputs.');
    if (
      data.kind === 'xray-dns-servers' &&
      (!jsonArray(j.servers) ||
        !j.servers.length ||
        j.servers.length > 128 ||
        Object.keys(j).some((k) => k !== 'servers'))
    )
      throw new Error('DNS server nodes contain one to 128 entries in a servers array.');
    if (
      data.kind === 'xray-options' &&
      (Object.keys(j).some((k) =>
        ['inbounds', 'outbounds', 'dns', 'observatory', 'burstObservatory'].includes(k),
      ) ||
        (jsonRecord(j.routing) &&
          ['rules', 'balancers'].some((k) => Object.hasOwn(j.routing as object, k))))
    )
      throw new Error('Managed sections belong in their graph nodes rather than core options.');
    const fields = (object: Record<string, unknown>, definitions: typeof dnsHandlerFields) => {
      for (const field of definitions) nativeFieldValue(field, nativeFieldText(object, field));
    };
    if (data.kind === 'xray-dns') fields(j, dnsHandlerFields);
    if (data.kind === 'xray-dns-servers')
      for (const server of j.servers as unknown[]) {
        const object =
          typeof server === 'string' ? { address: server } : jsonRecord(server) ? server : {};
        if (typeof object.address !== 'string' || !object.address)
          throw new Error('Every DNS server needs an address.');
        fields(object, dnsServerFields);
      }
    if (data.kind === 'xray-options') {
      if (j.metrics !== undefined && jsonRecord(j.metrics)) {
        fields(j.metrics, metricsFields);
        if (!metricsFields.some((f) => nativeFieldText(j.metrics as Record<string, unknown>, f)))
          throw new Error('Metrics needs a tag or listen address.');
      }
      if (jsonRecord(j.policy)) {
        if (jsonRecord(j.policy.levels))
          for (const [level, policy] of Object.entries(j.policy.levels)) {
            if (!/^(0|[1-9]\d*)$/.test(level) || Number(level) > 4294967295)
              throw new Error('Policy level must be 0–4294967295.');
            if (jsonRecord(policy)) fields(policy, policyLevelFields);
          }
        if (jsonRecord(j.policy.system)) fields(j.policy.system, policySystemFields);
      }
    }
  } catch (e) {
    return [
      {
        severity: 'error',
        fieldKey: 'json',
        message: e instanceof Error ? e.message : 'Invalid native options.',
      },
    ];
  }
  return [];
}

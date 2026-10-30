import { parseResources, factoryResources, renameResourceReferences } from './resources';
import {
  coreDefaultField,
  coreDefaultHint,
  coreDefaultValue,
  globalDefaultHint,
  configuredDefaultHint,
  formatDefault,
  valueAt,
  type DefaultHint,
} from './coreDefaults';
import { outboundDefinitions, outboundPreview, isExecutableOutboundKind } from './outbounds';
import { fieldProblem } from './settingValidation';
import { migrateUdpBufferDefaults, socketBufferValue, udpBufferFields } from './socketBuffers';
import { proxyDefinition, inboundPreview, isInboundKind } from './inbounds';
import { clearJsonUserAgents, rangeParts, validRange } from './trafficTuning';
import { jsonEqual, jsonText, jsonArray, parseJson, parseJsonObject } from './xrayJson';
import {
  commonPath,
  commonKeys,
  isProtocolKind,
  protocolInboundKinds,
  socketProtocolOutbounds,
  streamProtocolOutbounds,
  specForKind,
} from './protocols';
import type {
  Diagnostic,
  GlobalDefaults,
  GraphState,
  NodeKind,
  RuleNodeData,
  SettingDefinition,
  SettingValue,
} from './types';

export interface DefaultBinding {
  key: string;
  nodeKey: string;
  kinds: NodeKind[];
}
export interface GlobalField extends SettingDefinition {
  scope: string;
}
export const defaultSections = [
  {
    id: 'resources',
    title: 'Resource files',
    description: 'GeoIP and GeoSite files shared by all filters.',
  },
  {
    id: 'inputs',
    title: 'Traffic sources & name detection',
    description: 'UDP applies to SOCKS listeners. Sniffing detects names in incoming traffic.',
  },
  {
    id: 'security',
    title: 'TLS & User-Agent',
    description:
      'Shared client TLS tuning and transport headers. Server identity and account credentials stay in each node.',
  },
  {
    id: 'mux',
    title: 'Multiplexing',
    description:
      'Xray TCP mux and XUDP; remote server support is required. Vision requires TCP concurrency −1. XHTTP uses its own xmux tuning instead.',
  },
  {
    id: 'fragment',
    title: 'Fragmentation',
    description:
      'Separate outer secured-connection and inner client-traffic stages, using native Xray FinalMask.',
  },
  {
    id: 'connections',
    title: 'Connections & DNS strategy',
    description:
      'Local socket defaults for connecting outbounds. Availability of interface/socket features depends on Windows and the core.',
  },
  {
    id: 'transports',
    title: 'Transport tuning',
    description:
      'Defaults for the selected transport only; inactive transport settings are retained.',
  },
  {
    id: 'advanced',
    title: 'Additional core options',
    description:
      'Complete shared JSON objects for advanced tuning. Named fields take precedence over overlapping JSON keys.',
  },
  {
    id: 'core',
    title: 'Core, routing & policy',
    description:
      'Configuration-wide settings. DNS servers, DNS request policies and resolver preferences live in the DNS nodes.',
  },
] as const;
const sources = [
  ...proxyDefinition.fields,
  ...outboundDefinitions.find((d) => d.kind === 'vless-outbound')!.fields,
];
const networkFactoryDefaults: Record<string, SettingValue> = {
  udpReceiveBufferKiB: 256,
  udpSendBufferKiB: 256,
};
const fields: GlobalField[] = [],
  bindings: DefaultBinding[] = [];
const inputKinds: NodeKind[] = ['windivert-inbound', 'proxy-inbound', ...protocolInboundKinds],
  outputs: NodeKind[] = [
    'vless-outbound',
    'socks-outbound',
    'direct-outbound',
    ...socketProtocolOutbounds,
  ];
const streamOutputs: NodeKind[] = [
  'vless-outbound',
  'socks-outbound',
  ...streamProtocolOutbounds,
  'masque-outbound',
];
function bind(
  section: string,
  nodeKey: string,
  kinds: NodeKind[],
  key = nodeKey,
  label?: string,
  scope?: string,
) {
  kinds = kinds.filter((kind) => !isProtocolKind(kind) || commonKeys(kind).includes(nodeKey));
  const original = sources.find((f) => f.key === nodeKey);
  if (!original) throw new Error('Missing default field: ' + nodeKey);
  fields.push({
    ...original,
    key,
    section,
    defaultValue: networkFactoryDefaults[key] ?? original.defaultValue,
    label: label ?? original.label,
    visibleWhen: undefined,
    scope:
      scope ??
      kinds
        .map((k) => (specForKind(k) ? `${specForKind(k)!.title} ${specForKind(k)!.direction}` : k))
        .join(' / '),
  });
  bindings.push({ key, nodeKey, kinds });
}
for (const key of [
  'sniffing',
  'sniffHttp',
  'sniffTls',
  'routeOnly',
  'metadataOnly',
  'domainsExcluded',
  'ipsExcluded',
])
  bind('inputs', key, inputKinds);
bind('inputs', 'udp', ['proxy-inbound']);
bind('inputs', 'sniffQuic', ['windivert-inbound', 'proxy-inbound', ...protocolInboundKinds]);
bind('inputs', 'userLevel', inputKinds, 'inboundUserLevel', 'Input policy level');
bind(
  'advanced',
  'streamSettings',
  inputKinds.filter((kind) => kind !== 'tun-inbound' && kind !== 'windivert-inbound'),
  'inboundStreamSettings',
  'Input stream settings (JSON)',
);
for (const key of [
  'fingerprint',
  'alpn',
  'tlsMinVersion',
  'tlsMaxVersion',
  'sessionResumption',
  'cipherSuites',
  'curvePreferences',
  'userAgent',
])
  bind('security', key, streamOutputs);
for (const key of [
  'disableSystemRoot',
  'certificates',
  'tlsExtra',
  'echSockopt',
  'realityShow',
  'realityExtra',
])
  bind('advanced', key, streamOutputs);
for (const key of ['muxEnabled', 'muxConcurrency', 'xudpConcurrency', 'xudpProxyUDP443'])
  bind('mux', key, streamOutputs);
for (const key of [
  'fragmentEnabled',
  'finalFragmentEnabled',
  'fragmentPackets',
  'fragmentLengths',
  'fragmentDelays',
  'fragmentMaxSplit',
])
  bind('fragment', key, ['vless-outbound']);
for (const key of [
  'udpReceiveBufferKiB',
  'udpSendBufferKiB',
  'sendThrough',
  'interface',
  'tcpFastOpen',
  'tcpKeepAliveIdle',
  'tcpKeepAliveInterval',
  'tcpUserTimeout',
  'happyEyeballsEnabled',
  'happyEyeballsDelay',
  'happyEyeballsIPv6',
  'happyEyeballsInterleave',
  'happyEyeballsMax',
])
  bind('connections', key, outputs);
bind(
  'connections',
  'domainStrategy',
  streamOutputs,
  'proxyDomainStrategy',
  'Remote server DNS strategy',
);
bind(
  'connections',
  'domainStrategy',
  ['direct-outbound'],
  'directDomainStrategy',
  'Direct destination DNS strategy',
);
bind(
  'connections',
  'targetStrategy',
  streamOutputs,
  'targetStrategy',
  'Remote target DNS strategy',
);
bind('connections', 'userLevel', outputs, 'outboundUserLevel', 'Outbound policy level');
bind('advanced', 'sockoptExtra', outputs);
for (const key of [
  'wsHeartbeat',
  'xhttpMode',
  'grpcIdleTimeout',
  'grpcHealthTimeout',
  'grpcPermitWithoutStream',
  'grpcInitialWindow',
  'kcpMtu',
  'kcpTti',
  'kcpUp',
  'kcpDown',
  'kcpCwnd',
  'kcpWindow',
  'hysteriaUdpTimeout',
  'hysteriaUp',
  'hysteriaDown',
  'hysteriaHopInterval',
])
  bind('transports', key, streamOutputs);
bind('advanced', 'xhttpExtra', streamOutputs);
bind('advanced', 'finalmask', streamOutputs);
const root = (
  key: string,
  label: string,
  type: SettingDefinition['type'],
  defaultValue: SettingValue,
  extra: Partial<SettingDefinition> = {},
) =>
  fields.push({
    key,
    label,
    type,
    defaultValue,
    required: false,
    section: 'core',
    scope: 'Whole configuration',
    ...extra,
  });
root('logLevel', 'Core log level', 'select', 'warning', {
  options: ['debug', 'info', 'warning', 'error', 'none'],
  help: 'The service owns the log destinations. Access logs and arbitrary log-file paths remain disabled.',
});
for (const [key, label] of [
  ['udpListenerReceiveKiB', 'UDP listener receive buffer (KiB)'],
  ['udpListenerSendKiB', 'UDP listener send buffer (KiB)'],
])
  root(key, label, 'number', 256, {
    section: 'inputs',
    min: 0,
    max: 65536,
    help: '0 uses the Windows default. Applies on Apply/Start, including internal UDP listeners. Explicit listener socket options take precedence; SOCKS UDP associations use this shared setting.',
  });
root('dnsLog', 'Log core DNS activity', 'boolean', false, {
  help: 'Opt-in diagnostic logging may include queried names. Service events and core address masking do not encrypt logs.',
});
root('maskAddress', 'Mask destinations in copied / exported logs', 'select', 'full', {
  help: 'Live traffic destinations stay visible. Copy and export apply the selected IP mask and hide domain names when masking is enabled.',
  options: ['', 'quarter', 'half', 'full'],
  optionLabels: { '': 'No address masking', quarter: 'Quarter', half: 'Half', full: 'Full' },
});
root('routingDomainStrategy', 'Routing domain strategy', 'select', 'AsIs', {
  options: ['AsIs', 'IPIfNonMatch', 'IPOnDemand'],
  help: 'Controls DNS lookups used to evaluate destination-IP routing conditions; separate from outbound DNS strategy.',
});
root('statistics', 'Enable core statistics counters', 'boolean', false, {
  help: 'Select native counters in Core policy. Traffic statistics manages its own runtime counters.',
});
root('metricsEnabled', 'Enable core metrics', 'boolean', false, {
  help: 'Native metrics module. Tag-only mode uses routing; the Windows service restricts an optional HTTP listener to loopback.',
});
root('metricsTag', 'Metrics outbound tag', 'text', 'metrics');
root('metricsListen', 'Metrics listen address', 'text', '', {
  help: 'Optional 127.0.0.1:port or [::1]:port, using an unused port from 1024 to 65535.',
});
root('policy', 'Core policy (JSON)', 'json', '', {
  jsonShape: 'object',
  maxLength: 65536,
  help: 'levels and system only. Per-level handshake/connIdle/uplinkOnly/downlinkOnly seconds, bufferSize KiB and user counters; system inbound/outbound counters. Nodes select a policy level.',
  placeholder:
    '{"levels":{"0":{"handshake":4,"connIdle":300,"uplinkOnly":2,"downlinkOnly":5,"bufferSize":-1}}}',
});
export const globalFields = fields;
export const factoryDefaults = (): GlobalDefaults => ({
  version: 1,
  settings: Object.fromEntries(fields.map((f) => [f.key, f.defaultValue!])),
});
export const bindingFor = (kind: NodeKind, nodeKey: string) =>
  bindings.find((b) => b.nodeKey === nodeKey && b.kinds.includes(kind));
export const bindingsFor = (kind: NodeKind) => bindings.filter((b) => b.kinds.includes(kind));
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !jsonArray(value);
export function parseDefaults(raw: unknown): GlobalDefaults {
  if (!record(raw) || raw.version !== 1 || !record(raw.settings))
    throw new Error('Invalid global defaults.');
  if (
    Object.keys(raw).some((k) => !['version', 'settings', 'resources'].includes(k)) ||
    Object.keys(raw.settings).some((k) => !fields.some((f) => f.key === k))
  )
    throw new Error('Unknown global default.');
  // Absence means core inheritance. Never replace missing keys with app factory values.
  const settings = migrateUdpBufferDefaults({ ...raw.settings } as Record<string, SettingValue>);
  for (const field of fields) {
    if (!Object.hasOwn(settings, field.key)) continue;
    const problem = fieldProblem(field, settings);
    if (problem) throw new Error('Global defaults: ' + field.label + ' — ' + problem);
  }
  const errors = defaultsProblems({ version: 1, settings }).filter((i) => i.severity === 'error');
  if (errors.length) throw new Error(errors.map((i) => i.message).join('\n'));
  return {
    version: 1,
    settings,
    ...(raw.resources === undefined ? {} : { resources: parseResources(raw.resources) }),
  };
}
export function parseOverrides(kind: NodeKind, raw: unknown): string[] {
  if (
    !jsonArray(raw) ||
    raw.length > bindings.length ||
    raw.some((k) => typeof k !== 'string' || !bindingFor(kind, k)) ||
    new Set(raw).size !== raw.length
  )
    throw new Error('Invalid node default overrides.');
  return [...raw] as string[];
}
export function resolveNodeData(data: RuleNodeData, defaults?: GlobalDefaults): RuleNodeData {
  if (!defaults || data.overrides === undefined) return data;
  let settings: RuleNodeData['settings'] | undefined;
  const coreDefaults: string[] = [];
  for (const binding of bindingsFor(data.kind)) {
    if (data.overrides.includes(binding.nodeKey)) continue;
    const configured = defaults.settings[binding.key];
    const field = sources.find((field) => field.key === binding.nodeKey);
    const value =
      configured ??
      (field?.optional && field.defaultValue === undefined
        ? undefined
        : coreDefaultValue(binding.key));
    if (!Object.is(data.settings[binding.nodeKey], value)) {
      settings ??= { ...data.settings };
      if (value === undefined) delete settings[binding.nodeKey];
      else settings[binding.nodeKey] = value;
    }
    if (configured === undefined) coreDefaults.push(binding.nodeKey);
  }
  const oldCoreDefaults = data.coreDefaults ?? [];
  const sameOmissions =
    oldCoreDefaults.length === coreDefaults.length &&
    oldCoreDefaults.every((key, index) => key === coreDefaults[index]);
  // Unchanged identities keep validated policy snapshots and shared pool caches warm.
  if (!settings && sameOmissions) return data;
  return {
    ...data,
    settings: settings ?? data.settings,
    coreDefaults: sameOmissions ? data.coreDefaults : coreDefaults,
  };
}
export function resolveGraph(graph: GraphState): GraphState {
  if (!graph.defaults) return graph;
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const data = resolveNodeData(node.data, graph.defaults);
    if (data === node.data) return node;
    changed = true;
    return { ...node, data };
  });
  return changed ? { ...graph, nodes } : graph;
}
// New examples infer overrides by value. Saved graphs store explicit override keys.
export function enableDefaults(graph: GraphState): GraphState {
  if (graph.defaults) return resolveGraph(graph);
  const defaults = factoryDefaults();
  return resolveGraph({
    ...graph,
    defaults,
    nodes: graph.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        overrides: bindingsFor(node.data.kind)
          .filter(
            (b) =>
              node.data.settings[b.nodeKey] !== defaults.settings[b.key] &&
              // Blank template socket JSON follows app defaults. Saved explicit
              // overrides (including blanks) are handled above and stay intact.
              !(Object.hasOwn(networkFactoryDefaults, b.key) && !node.data.settings[b.nodeKey]),
          )
          .map((b) => b.nodeKey),
      },
    })),
  });
}
export function applyDefaults(graph: GraphState, defaults: GlobalDefaults): GraphState {
  const parsed = parseDefaults(defaults);
  const renamed = renameResourceReferences(graph, parsed.resources ?? factoryResources());
  return resolveGraph({ ...enableDefaults(renamed), defaults: parsed });
}
export function resetNodeDefaults(
  data: RuleNodeData,
  defaults: GlobalDefaults,
  nodeKey?: string,
): RuleNodeData {
  const settings =
    !nodeKey || nodeKey === 'userAgent' ? clearJsonUserAgents(data.settings) : { ...data.settings };
  return resolveNodeData(
    {
      ...data,
      settings,
      ...(data.native
        ? {
            native: {
              ...data.native,
              editedKeys: nodeKey ? data.native.editedKeys?.filter((k) => k !== nodeKey) : [],
            },
          }
        : {}),
      overrides: nodeKey
        ? (data.overrides ?? bindingsFor(data.kind).map((b) => b.nodeKey)).filter(
            (k) => k !== nodeKey,
          )
        : [],
    },
    defaults,
  );
}
export function overrideSetting(
  data: RuleNodeData,
  nodeKey: string,
  value: SettingValue,
): Partial<RuleNodeData> {
  const settings =
    nodeKey === 'userAgent' ? clearJsonUserAgents(data.settings) : { ...data.settings };
  settings[nodeKey] = value;
  return {
    settings,
    ...(data.native && bindingFor(data.kind, nodeKey)
      ? {
          native: {
            ...data.native,
            editedKeys: [...new Set([...(data.native.editedKeys ?? []), nodeKey])],
          },
        }
      : {}),
    coreDefaults: data.coreDefaults?.filter((k) => k !== nodeKey),
    overrides: bindingFor(data.kind, nodeKey)
      ? [...new Set([...(data.overrides ?? bindingsFor(data.kind).map((b) => b.nodeKey)), nodeKey])]
      : data.overrides,
  };
}
export function defaultsProblems(defaults: GlobalDefaults): Diagnostic[] {
  const s = effectiveDefaults(defaults),
    result: Diagnostic[] = [];
  const add = (fieldKey: string, message: string) =>
    result.push({ severity: 'error', fieldKey, message: 'Global defaults: ' + message });
  try {
    parseResources(defaults.resources ?? factoryResources());
  } catch (e) {
    add('resources', (e as Error).message);
  }
  if (
    s.metricsEnabled &&
    !String(s.metricsTag ?? '').trim() &&
    !String(s.metricsListen ?? '').trim()
  )
    add('metricsTag', 'Metrics needs a tag or a listen address.');
  if (
    s.metricsEnabled &&
    s.metricsListen &&
    !/^(?:127\.0\.0\.1|\[::1\]):\d+$/.test(String(s.metricsListen))
  )
    result.push({
      severity: 'warning',
      fieldKey: 'metricsListen',
      message: 'The Windows service requires an explicit loopback metrics address.',
    });
  if (s.metricsEnabled && s.metricsListen) {
    const port = Number(String(s.metricsListen).split(':').at(-1));
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      add('metricsListen', 'Metrics port must be 1–65535.');
    else if (port < 1024)
      result.push({
        severity: 'warning',
        fieldKey: 'metricsListen',
        message: 'The service requires a metrics port of at least 1024.',
      });
  }
  for (const f of fields) {
    if (!Object.hasOwn(defaults.settings, f.key)) continue;
    const problem = fieldProblem(f, s);
    if (problem) add(f.key, f.label + ' — ' + problem);
  }
  if (s.userAgent && /[\r\n\0]/.test(String(s.userAgent)))
    add('userAgent', 'User-Agent cannot contain line breaks or NUL.');
  if (s.tlsMinVersion && s.tlsMaxVersion && Number(s.tlsMinVersion) > Number(s.tlsMaxVersion))
    add('tlsMaxVersion', 'Maximum TLS version is below the minimum.');
  if (
    (Object.hasOwn(defaults.settings, 'fragmentPackets') ||
      s.fragmentEnabled ||
      s.finalFragmentEnabled) &&
    s.fragmentPackets &&
    s.fragmentPackets !== 'tlshello' &&
    !validRange(String(s.fragmentPackets), 1)
  )
    add('fragmentPackets', 'Use tlshello or a positive packet number/range.');
  for (const key of ['fragmentLengths', 'fragmentDelays']) {
    if (!Object.hasOwn(defaults.settings, key) && !s.fragmentEnabled && !s.finalFragmentEnabled)
      continue;
    const parts = rangeParts(s[key]);
    if (
      !parts.length ||
      parts.some((p) => !validRange(p)) ||
      (key === 'fragmentLengths' && !validRange(parts.at(-1)!, 1))
    )
      add(key, 'Invalid ordered fragmentation ranges.');
  }
  if (
    (Object.hasOwn(defaults.settings, 'fragmentMaxSplit') ||
      s.fragmentEnabled ||
      s.finalFragmentEnabled) &&
    !validRange(String(s.fragmentMaxSplit))
  )
    add('fragmentMaxSplit', 'Invalid maximum split number/range.');
  if (!validRange(String(s.hysteriaHopInterval), 5))
    add('hysteriaHopInterval', 'Hop intervals must be at least 5 seconds.');
  try {
    if (s.tlsExtra && parseJsonObject(String(s.tlsExtra)).allowInsecure !== undefined)
      add('tlsExtra', 'allowInsecure was removed from this Xray core.');
  } catch {
    /* Field validation handles syntax. */
  }
  if (s.policy) {
    try {
      const p: unknown = parseJson(String(s.policy));
      const timeoutKeys = ['handshake', 'connIdle', 'uplinkOnly', 'downlinkOnly'];
      const counterKeys = ['statsUserUplink', 'statsUserDownlink', 'statsUserOnline'];
      if (!record(p) || Object.keys(p).some((k) => !['levels', 'system'].includes(k)))
        throw new Error();
      if (p.levels !== undefined) {
        if (!record(p.levels) || Object.keys(p.levels).length > 64) throw new Error();
        for (const [level, values] of Object.entries(p.levels)) {
          if (!/^(0|[1-9]\d*)$/.test(level) || Number(level) > 4294967295 || !record(values))
            throw new Error();
          for (const [key, value] of Object.entries(values)) {
            if (timeoutKeys.includes(key)) {
              if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 4294967295)
                throw new Error();
            } else if (counterKeys.includes(key)) {
              if (typeof value !== 'boolean') throw new Error();
            } else if (key === 'bufferSize') {
              if (!Number.isInteger(value) || Number(value) < -1 || Number(value) > 2097151)
                throw new Error();
            } else throw new Error();
          }
        }
      }
      if (
        p.system !== undefined &&
        (!record(p.system) ||
          Object.entries(p.system).some(
            ([key, value]) =>
              ![
                'statsInboundUplink',
                'statsInboundDownlink',
                'statsOutboundUplink',
                'statsOutboundDownlink',
              ].includes(key) || typeof value !== 'boolean',
          ))
      )
        throw new Error();
    } catch {
      add(
        'policy',
        'Use supported levels/system policy keys with valid seconds, KiB sizes and boolean counters.',
      );
    }
  }
  return result;
}

export function effectiveDefaults(defaults: GlobalDefaults): Record<string, SettingValue> {
  return Object.fromEntries(
    globalFields.map((f) => [f.key, defaults.settings[f.key] ?? coreDefaultValue(f.key)]),
  );
}
export function resetCoreDefault(defaults: GlobalDefaults, key?: string): GlobalDefaults {
  const settings = { ...defaults.settings };
  if (key) delete settings[key];
  else for (const field of globalFields) delete settings[field.key];
  return { ...defaults, version: 1, settings };
}
export interface SettingDefaultState {
  label: string;
  detail: string;
  independent: boolean;
  inherited: boolean;
  hint?: DefaultHint;
  resetHint?: DefaultHint;
  effectiveText?: string;
}
function settingPath(data: RuleNodeData, key: string, root: Record<string, unknown>) {
  return (
    commonPath(key, root, data.kind.endsWith('inbound') ? 'inbound' : 'outbound') ??
    (key === 'udp'
      ? ['settings', 'udp']
      : ['sniffHttp', 'sniffTls', 'sniffQuic'].includes(key)
        ? ['sniffing', 'destOverride']
        : key === 'userLevel' && ['proxy-inbound', 'direct-outbound'].includes(data.kind)
          ? ['settings', 'userLevel']
          : key === 'userLevel' && ['vless-outbound', 'socks-outbound'].includes(data.kind)
            ? ['settings', 'level']
            : undefined)
  );
}
// Presentation follows emitted native fields, not the encoded placeholders
// used by the graph. In particular, an imported omission is not an explicit 0.
export function settingDefaultState(
  data: RuleNodeData,
  field: SettingDefinition,
  defaults?: GlobalDefaults,
  preparedRoot?: Record<string, unknown> | null,
): SettingDefaultState {
  const binding = bindingFor(data.kind, field.key),
    independent = !!binding && (data.overrides?.includes(field.key) ?? true);
  let root = preparedRoot ?? undefined;
  if (preparedRoot === undefined)
    try {
      root = isExecutableOutboundKind(data.kind)
        ? outboundPreview(data)
        : isInboundKind(data.kind)
          ? inboundPreview(data)
          : undefined;
    } catch {
      /* Invalid drafts already have diagnostics. */
    }
  const direction = data.kind.endsWith('inbound') ? ('inbound' as const) : ('outbound' as const),
    context = {
      root,
      direction: direction,
      network: jsonText(
        valueAt(root, ['streamSettings', 'method']) ??
          valueAt(root, ['streamSettings', 'network']) ??
          data.settings.network ??
          'raw',
      ),
    },
    hint = settingDefaultHint(data, field, defaults, root ?? null),
    resetHint =
      binding && defaults && independent
        ? settingDefaultHint(resetNodeDefaults(data, defaults, field.key), field, defaults)
        : undefined;
  const result: SettingDefaultState = {
    label: independent
      ? 'Overridden'
      : hint?.source === 'global'
        ? 'App default'
        : hint?.source === 'native'
          ? 'Native value'
          : 'Xray default',
    detail: independent
      ? 'This node keeps its own value when app defaults change.'
      : hint?.source === 'global'
        ? 'Follows the defaults for this graph.'
        : hint?.source === 'native'
          ? 'Configured by native options in this node.'
          : 'Uses the embedded core’s contextual default.',
    independent,
    inherited: !!binding && !independent,
    hint,
    resetHint,
  };
  if (
    binding &&
    independent &&
    (data.native || isProtocolKind(data.kind)) &&
    root &&
    !data.native?.editedKeys?.includes(field.key)
  ) {
    const path = settingPath(data, field.key, root);
    if (path?.includes('*')) {
      result.label = 'Native account settings';
      result.detail = 'Account values can differ. Inspect them in Server & account.';
      result.inherited = true;
      result.hint = { text: 'Per-account values — see Server & account', source: 'native' };
    } else if (path) {
      const current = valueAt(root, path),
        original = valueAt(data.native?.original, path);
      if (current === undefined) {
        result.label =
          data.native && original === undefined ? 'Imported omission' : 'Node omission';
        result.detail = 'Kept absent from Xray JSON. App defaults do not replace this omission.';
        result.inherited = true;
        result.hint = coreDefaultHint(coreDefaultField(binding.key), context);
      } else if (data.native && jsonEqual(original, current)) {
        result.label = 'Imported value';
        result.detail = 'Keeps the imported value, even when it equals the app or Xray default.';
      }
    }
  }
  if (binding && independent && !result.inherited && data.settings[field.key] === 0) {
    const text = configuredDefaultHint(binding.key, 0, context);
    if (text !== '0') result.effectiveText = text;
  }
  return result;
}
export function settingDefaultHint(
  data: RuleNodeData,
  field: SettingDefinition,
  defaults?: GlobalDefaults,
  preparedRoot?: Record<string, unknown> | null,
): DefaultHint | undefined {
  let root: Record<string, unknown> | undefined = preparedRoot ?? undefined;
  if (preparedRoot === undefined)
    try {
      root = isExecutableOutboundKind(data.kind)
        ? outboundPreview(data)
        : isInboundKind(data.kind)
          ? inboundPreview(data)
          : undefined;
    } catch {
      /* Invalid drafts already have diagnostics. */
    }
  const binding = bindingFor(data.kind, field.key),
    context = {
      root,
      direction: data.kind.endsWith('inbound') ? ('inbound' as const) : ('outbound' as const),
      network: jsonText(
        valueAt(root, ['streamSettings', 'method']) ??
          valueAt(root, ['streamSettings', 'network']) ??
          data.settings.network ??
          'raw',
      ),
    };
  if (binding) {
    if (field.key in udpBufferFields && !data.overrides?.includes(field.key)) {
      const socket = valueAt(root, ['streamSettings', 'sockopt']);
      if (record(socket)) {
        const size = socketBufferValue(
          socket,
          'udp',
          udpBufferFields[field.key as keyof typeof udpBufferFields],
        ).value;
        if (size !== undefined && size !== Number(data.settings[field.key]) * 1024)
          return {
            text: `${size / 1024}`,
            source: 'native',
            detail: 'Configured by this node’s socket options.',
          };
      }
    }
    if (!data.overrides?.includes(field.key)) {
      if (
        (defaults?.settings[binding.key] === undefined || defaults.settings[binding.key] === '') &&
        ['sockoptExtra', 'tlsExtra', 'realityExtra', 'xhttpExtra'].some((k) => data.settings[k])
      )
        try {
          const raw = root,
            path = raw && commonPath(field.key, raw, context.direction),
            value = path && valueAt(raw, path);
          const extraKey =
            path &&
            (
              {
                sockopt: 'sockoptExtra',
                tlsSettings: 'tlsExtra',
                realitySettings: 'realityExtra',
                xhttpSettings: 'xhttpExtra',
              } as Record<string, string>
            )[path[1]];
          if (value !== undefined && value !== '')
            return {
              text: formatDefault(value),
              source: extraKey && data.overrides?.includes(extraKey) ? 'native' : 'global',
              detail: 'Configured by advanced options; the named app default is unset.',
            };
        } catch {
          /* A malformed draft already has field diagnostics. */
        }
      return globalDefaultHint(binding.key, defaults, context);
    }
    const path = root && commonPath(field.key, root, context.direction),
      value = path && !path.includes('*') && valueAt(root, path);
    if (data.settings[field.key] === '' && value !== undefined && value !== '')
      return {
        text: formatDefault(value),
        source: 'native',
        detail: 'Configured by native options in this node.',
      };
    return coreDefaultHint(coreDefaultField(binding.key), context);
  }
  const keys: Record<string, string> = {
    path: 'WebSocketConfig.path',
    host: 'WebSocketConfig.host',
    serverName: 'TLSConfig.serverName',
    spiderX: 'REALITYConfig.spiderX',
    flow: 'VLessOutboundConfig.flow',
    encryption: 'VLessOutboundConfig.encryption',
    network: 'StreamConfig.network',
    security: 'StreamConfig.security',
    grpcAuthority: 'GRPCConfig.authority',
    grpcServiceName: 'GRPCConfig.serviceName',
    grpcMultiMode: 'GRPCConfig.multiMode',
    dialerProxy: 'SocketConfig.dialerProxy',
    redirect: 'FreedomConfig.redirect',
    pinnedPeerCertSha256: 'TLSConfig.pinnedPeerCertSha256',
    verifyPeerCertByName: 'TLSConfig.verifyPeerCertByName',
    rawHeader: 'TCPConfig.header',
    headers: 'WebSocketConfig.headers',
    reverse: 'VLessOutboundConfig.reverse',
    streamAddress: 'StreamConfig.address',
    streamPort: 'StreamConfig.port',
  };
  if (field.required) return { text: 'Required — no default', source: 'core' };
  if (['policy-group', 'observatory'].includes(data.kind)) {
    const key =
      field.key === 'connectivity'
        ? 'HealthCheck.connectivity'
        : field.key === 'baselines'
          ? 'LeastLoad.baselines'
          : field.key === 'costs'
            ? 'LeastLoad.costs'
            : ['extra', 'strategyExtra', 'healthExtra'].includes(field.key)
              ? 'App.extra'
              : undefined;
    if (key) return coreDefaultHint(key, context);
  }
  return keys[field.key] ? coreDefaultHint(keys[field.key], context) : undefined;
}

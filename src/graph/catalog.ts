import { jsonArray } from './xrayJson';
import { isNativeXrayKind, nativeOutputs, nativeSummary, xrayDefinitions } from './xrayNodes';
import type { NodeDefinition, NodeKind, RuleNode, RuleNodeData, SettingValue } from './types';
import { policyDefinitions, policyPorts } from './policies';
import { fakeDnsDefinition, fakeDnsPools } from './fakeDns';
import { readPolicySources } from './policySources';
import { outboundDefinitions, isOutboundKind } from './outbounds';
import {
  captureDefinition,
  isInboundKind,
  proxyDefinition,
  proxyModeLabels,
  type ProxyMode,
} from './inbounds';
import { isRuleTableKind, namedOutputs, readRuleTable, ruleTableDefinitions } from './rules';
import {
  dnsDefinitions,
  dnsOutputs,
  isDnsEditor,
  readDnsFilter,
  readDnsPolicies,
  readDnsServers,
} from './dns';
import {
  isProtocolInbound,
  captureNodeName,
  isProtocolKind,
  protocolDefinitions,
  protocolSummary,
} from './protocols';

import { proxyChainDefinition, readProxyChain } from './proxyChains';

export const catalog: NodeDefinition[] = [
  captureDefinition,
  proxyDefinition,
  ...ruleTableDefinitions,
  ...dnsDefinitions,
  fakeDnsDefinition,
  ...outboundDefinitions,
  ...protocolDefinitions(
    outboundDefinitions.find((d) => d.kind === 'socks-outbound')!,
    proxyDefinition,
  ),
  ...policyDefinitions,
  proxyChainDefinition,
  ...xrayDefinitions,
];

export const availableNodes = catalog;

export const getDefinition = (kind: NodeKind) => catalog.find((item) => item.kind === kind)!;
export const isNodeKind = (kind: unknown): kind is NodeKind =>
  catalog.some((item) => item.kind === kind);
export const getOutputPorts = (kind: NodeKind, data?: RuleNodeData): string[] => {
  const configured = data ?? {
    kind,
    settings: getDefinition(kind).defaults,
    label: '',
    description: '',
  };
  if (isOutboundKind(kind) && kind !== 'block-outbound') return ['observation'];
  if (kind === 'fakedns') return [];
  if (isNativeXrayKind(kind)) return nativeOutputs(configured).map((p) => p.id);
  if (kind === 'observatory') return policyPorts(configured).map((p) => p.id);
  if (isDnsEditor(configured)) return dnsOutputs(configured).map((output) => output.id);
  if (isRuleTableKind(kind))
    return namedOutputs(
      data ?? { kind, settings: getDefinition(kind).defaults, label: '', description: '' },
    ).map((output) => output.id);
  if (kind === 'tun-inbound')
    return [
      'traffic',
      'dns',
      ...(configured.settings.separateNatTraffic === true ? ['nat-data', 'nat-dns'] : []),
    ];
  if (kind === 'ics-tun') return ['traffic'];
  if (isProtocolInbound(kind)) return ['traffic'];
  if (isInboundKind(kind))
    return ['data', 'dns', ...(configured.settings.encryptedDnsPorts ? ['encrypted-dns'] : [])];
  const category = getDefinition(kind).category;
  return category === 'outbound' ? [] : ['traffic'];
};
export const hasInputPort = (kind: NodeKind) =>
  !['xray-options', 'xray-dns'].includes(kind) && getDefinition(kind).category !== 'inbound';
export const portLabel = (port: string, data?: RuleNodeData) =>
  port === 'observation'
    ? 'Observation'
    : data && isNativeXrayKind(data.kind)
      ? (nativeOutputs(data).find((p) => p.id === port)?.name ?? port)
      : data &&
          (data.kind === 'policy-group' ||
            data.kind === 'proxy-chain' ||
            data.kind === 'observatory')
        ? (policyPorts(data).find((p) => p.id === port)?.name ?? port)
        : data && isDnsEditor(data)
          ? (dnsOutputs(data).find((output) => output.id === port)?.name ?? port)
          : data && isRuleTableKind(data.kind)
            ? (namedOutputs(data).find((output) => output.id === port)?.name ?? port)
            : port === 'nat-data'
              ? 'NAT Data'
              : port === 'nat-dns'
                ? 'NAT DNS'
                : port === 'data' ||
                    (port === 'traffic' && data && ['tun-inbound', 'ics-tun'].includes(data.kind))
                  ? 'Data'
                  : port === 'dns'
                    ? 'DNS'
                    : port === 'encrypted-dns'
                      ? 'Encrypted DNS'
                      : 'Traffic';

export function makeNode(
  kind: NodeKind,
  position: { x: number; y: number },
  id: string = crypto.randomUUID(),
): RuleNode {
  const definition = getDefinition(kind);
  return {
    id,
    type: 'rule',
    position,
    data: {
      kind,
      label: captureNodeName({
        kind,
        label: definition.title,
        description: '',
        settings: definition.defaults,
      }),
      description: '',
      settings: { ...definition.defaults },
      overrides: [],
    },
  };
}

export function makeProxyInbound(
  mode: ProxyMode,
  position: RuleNode['position'],
  id?: string,
): RuleNode {
  const node = makeNode('proxy-inbound', position, id);
  node.data.settings.mode = mode;
  return node;
}

export function summarizeNode(data: RuleNodeData): [string, string][] {
  if (isProtocolKind(data.kind)) return protocolSummary(data);
  if (isNativeXrayKind(data.kind)) return nativeSummary(data);
  const settings = data.settings;
  const value = (key: string): string => String(settings[key] ?? '');
  switch (data.kind) {
    case 'fakedns': {
      try {
        const pools = fakeDnsPools(data);
        return [
          [
            'Pools',
            pools === undefined
              ? 'Core defaults'
              : `${jsonArray(pools) ? pools.length : 1} shared pool(s)`,
          ],
          ['Resolver', 'Synthetic DNS answers'],
        ];
      } catch {
        return [['Pools', 'Invalid configuration']];
      }
    }
    case 'proxy-chain': {
      try {
        return [
          ['Hops', String(readProxyChain(data).steps.length)],
          ['Order', 'This PC to destination'],
        ];
      } catch {
        return [['Hops', 'Invalid configuration']];
      }
    }
    case 'policy-group':
      return [
        [
          'Strategy',
          (
            {
              random: 'Random',
              roundRobin: 'Round robin',
              leastPing: 'Lowest latency',
              leastLoad: 'Least load',
            } as Record<string, string>
          )[value('strategy')],
        ],
      ];
    case 'observatory':
      return [
        ['Probes', settings.mode === 'burst' ? 'Burst health sampling' : 'Standard latency'],
        ['Subjects', settings.subjects === 'groups' ? 'Connected groups' : 'Tag prefixes'],
      ];
    case 'dns-servers': {
      try {
        const entries = readDnsServers(settings);
        return [
          [
            'Servers',
            `${entries.filter((s) => s.enabled).length} active · ${entries.length} total`,
          ],
          ['First', entries.find((s) => s.enabled)?.address ?? 'None'],
        ];
      } catch {
        return [['Servers', 'Invalid configuration']];
      }
    }
    case 'dns-routing-filter':
    case 'dns-handler':
    case 'routing-filter':
      return [];
    case 'proxy-inbound':
      return [
        ['Listen', `${value('listen')}:${value('port')}`],
        ['Mode', proxyModeLabels[settings.mode as ProxyMode]],
      ];
    case 'windivert-inbound':
      return [];
    case 'socks-outbound':
      return [
        ['Server', `${value('address')}:${value('port')}`],
        ['Account', value('auth') === 'password' ? 'Username / password' : 'No authentication'],
      ];
    case 'vless-outbound':
      return [
        ['Server', `${value('address')}:${value('port')}`],
        ['Transport', `${value('network').toUpperCase()} · ${value('security').toUpperCase()}`],
      ];
    case 'direct-outbound':
    case 'block-outbound':
      return [];
  }
}

export function validateSettings(kind: NodeKind, raw: unknown): Record<string, SettingValue> {
  if (!raw || typeof raw !== 'object' || jsonArray(raw))
    throw new Error('Node settings must be an object.');
  const values = raw as Record<string, unknown>;
  if (kind === 'dns-handler' && values.dnsModel !== undefined && values.dnsModel !== 'xray')
    throw new Error('Legacy DNS graph formats are no longer supported.');
  const settings: Record<string, SettingValue> = {};
  for (const field of getDefinition(kind).fields) {
    const value =
      values[field.key] === undefined && ['dnsPorts', 'encryptedDnsPorts'].includes(field.key)
        ? getDefinition(kind).defaults[field.key]
        : values[field.key];
    if (value === undefined && field.optional) continue;
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`Invalid ${field.label}.`);
    } else if (field.type === 'number') {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < (field.min ?? -Infinity) ||
        value > (field.max ?? Infinity)
      )
        throw new Error(`Invalid ${field.label}.`);
    } else if (
      typeof value !== 'string' ||
      value.length > (field.maxLength ?? 4096) ||
      (field.options && !field.options.includes(value))
    ) {
      throw new Error(`Invalid ${field.label}.`);
    }
    settings[field.key] = value;
  }
  if (kind === 'policy-group') readPolicySources({ kind, settings, label: '', description: '' });
  if (kind === 'dns-servers') readDnsServers(settings);
  else if (kind === 'dns-routing-filter') readDnsFilter(settings);
  else if (kind === 'dns-handler') readDnsPolicies(settings);
  else if (isRuleTableKind(kind)) readRuleTable(settings);
  return settings;
}

export function uniqueOutboundTag(base: string, nodes: RuleNode[]): string {
  const tags = new Set(nodes.map((node) => String(node.data.settings.tag ?? '')));
  if (!tags.has(base)) return base;
  let index = 2;
  while (tags.has(`${base}-${index}`)) index++;
  return `${base}-${index}`;
}

export const uniqueInboundTag = (base: string, nodes: RuleNode[]) =>
  uniqueOutboundTag(
    base,
    nodes.filter((node) => getDefinition(node.data.kind).category === 'inbound'),
  );

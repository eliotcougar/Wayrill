import { enabledInboundGraph } from './inboundState';
import { capturesSystemDns } from './dnsCapture';
import { jsonArray, jsonRecord, parseJson } from './xrayJson';
import { validateRuleSource, type RuleSource } from './ruleSourceModel';
import { validateDnsSourceRow, type DnsSourceRow } from './dnsRuleSourceModel';
import { LIMITS } from '../limits';
import { resourceCompilationGraph } from './resources';
import { dnsIpLiteral as literal, dnsAddressProblem } from './addressValidation';
export { dnsAddressProblem } from './addressValidation';
import {
  fakeDnsServers,
  fakeDnsNodeProblems,
  compileFakeDnsPools,
  automaticFakeDns,
  FAKE_DNS_PORT,
} from './fakeDns';
import { compilePolicies } from './policies';
import { domainProblem, ipProblem, listEntries, portRangeProblem } from './rules';
import { nativeConfig } from './xrayNodes';
import { isExecutableOutboundKind, outboundBundle, outboundProblems } from './outbounds';
import { resolveGraph } from './defaults';
import type {
  Diagnostic,
  GraphState,
  NodeDefinition,
  RuleNodeData,
  SettingDefinition,
  SettingValue,
} from './types';

export const families = ['inherit', 'UseIP', 'UseIPv4', 'UseIPv6', 'UseSystem'] as const;
export const familyNames: Record<string, string> = {
  inherit: 'Use handler setting',
  UseIP: 'IPv4 and IPv6',
  UseIPv4: 'IPv4 only',
  UseIPv6: 'IPv6 only',
  UseSystem: 'Follow system availability',
};
export interface DnsServer {
  id: string;
  name: string;
  enabled: boolean;
  address: string;
  port: number;
  queryStrategy: string;
  clientIP: string;
  timeoutMs: number;
  cache: string;
  stale: string;
  staleTTL: number;
}
export interface DnsOutput {
  id: string;
  name: string;
  // Permanent fallback port role; never selected by an output checkbox.
  fallback: boolean;
}
export interface DnsRoute {
  id: string;
  name: string;
  enabled: boolean;
  output: string;
  domains: string;
  expectedIPs: string;
  unexpectedIPs: string;
  skipFallback: boolean;
  finalQuery: boolean;
  source?: DnsSourceRow;
}
export interface DnsFilter {
  fallbackFirst?: boolean;
  outputs: DnsOutput[];
  rules: DnsRoute[];
  fallbackMode: string;
  parallel: boolean;
  source?: RuleSource;
}
export interface DnsPolicy {
  id: string;
  name: string;
  enabled: boolean;
  domain: string;
  qType: string;
  action: 'resolve' | 'forward' | 'return' | 'drop';
  rCode: number;
}
export const newDnsServer = (id: string = crypto.randomUUID()): DnsServer => ({
  id,
  name: 'DNS server',
  enabled: true,
  address: '1.1.1.1',
  port: 53,
  queryStrategy: 'inherit',
  clientIP: '',
  timeoutMs: 4000,
  cache: 'inherit',
  stale: 'inherit',
  staleTTL: 0,
});
export const newDnsRoute = (output: string, id: string = crypto.randomUUID()): DnsRoute => ({
  id,
  name: 'Domain preference',
  enabled: true,
  output,
  domains: '',
  expectedIPs: '',
  unexpectedIPs: '',
  skipFallback: true,
  finalQuery: false,
});
export const newDnsPolicy = (id: string = crypto.randomUUID()): DnsPolicy => ({
  id,
  name: 'DNS query rule',
  enabled: true,
  domain: '',
  qType: '65',
  action: 'return',
  rCode: 0,
});
const initialPolicies: DnsPolicy[] = [
  { ...newDnsPolicy('addresses'), name: 'Resolve A / AAAA', qType: '1,28', action: 'resolve' },
];
const nativeHandlerDefaults: Record<string, SettingValue> = {
  tag: 'dns-handler',
  disableCache: false,
  policyRules: JSON.stringify(initialPolicies),
  policyDefault: 'return',
  policyRCode: 0,
  queryStrategy: 'UseIP',
  hosts: '{}',
  clientIP: '',
  useSystemHosts: false,
  serveStale: false,
  serveExpiredTTL: 0,
  rewriteNetwork: 'udp',
  rewriteAddress: '1.1.1.1',
  rewritePort: 53,
};
const nativeHandlerFields: SettingDefinition[] = (
  [
    { key: 'tag', label: 'Handler tag', type: 'text', required: true, maxLength: 128 },
    { key: 'disableCache', label: 'Disable resolver cache', type: 'boolean' },
    {
      key: 'policyRules',
      label: 'DNS query policy',
      type: 'json',
      jsonShape: 'array',
      maxLength: 524288,
    },
    {
      key: 'policyDefault',
      label: 'Other record types',
      type: 'select',
      options: ['forward', 'return', 'drop'],
    },
    { key: 'policyRCode', label: 'Default response code', type: 'number', min: 0, max: 65535 },
    {
      key: 'queryStrategy',
      label: 'Address family',
      type: 'select',
      options: families.slice(1),
      optionLabels: familyNames,
    },
    {
      key: 'hosts',
      label: 'Static hosts / bootstrap',
      type: 'json',
      jsonShape: 'object',
      maxLength: 131072,
    },
    { key: 'clientIP', label: 'EDNS client IP', type: 'text', maxLength: 128, required: false },
    { key: 'useSystemHosts', label: 'Use system hosts', type: 'boolean' },
    { key: 'serveStale', label: 'Serve stale cached answers', type: 'boolean' },
    { key: 'serveExpiredTTL', label: 'Stale answer TTL', type: 'number', min: 0, max: 4294967295 },
    {
      key: 'rewriteNetwork',
      label: 'Forwarded query network',
      type: 'select',
      options: ['udp', 'tcp'],
    },
    { key: 'rewriteAddress', label: 'Forwarded query address', type: 'text', maxLength: 4096 },
    { key: 'rewritePort', label: 'Forwarded query port', type: 'number', min: 1, max: 65535 },
  ] satisfies SettingDefinition[]
).map((field) => ({ ...field, defaultValue: nativeHandlerDefaults[field.key] }));
export const dnsDefinitions: NodeDefinition[] = [
  {
    kind: 'dns-handler',
    title: 'DNS handler',
    group: 'Rules & filters',
    category: 'rule',
    summary: 'Xray DNS query policy, address family, cache and static hosts',
    defaults: nativeHandlerDefaults,
    fields: nativeHandlerFields,
  },
  {
    kind: 'dns-routing-filter',
    title: 'DNS routing filter',
    group: 'Rules & filters',
    category: 'filter',
    summary: 'Domain preferences, answer IP checks and resolver fallback',
    defaults: {
      outputs: JSON.stringify([{ id: 'default', name: 'Fallback', fallback: true }]),
      rules: '[]',
      fallbackMode: 'always',
      parallel: false,
    },
    fields: [
      {
        key: 'outputs',
        label: 'Named resolver outputs',
        type: 'json',
        jsonShape: 'array',
        maxLength: 65536,
      },
      {
        key: 'rules',
        label: 'Domain preferences',
        type: 'json',
        jsonShape: 'array',
        maxLength: 524288,
      },
      {
        key: 'fallbackMode',
        label: 'Fallback policy',
        type: 'select',
        options: ['always', 'when-unmatched', 'disabled'],
      },
      { key: 'parallel', label: 'Parallel equivalent servers', type: 'boolean' },
      {
        key: 'ruleSource',
        label: 'Rule source',
        type: 'json',
        jsonShape: 'object',
        optional: true,
        maxLength: LIMITS.configBytes,
      },
      {
        key: 'fallbackFirst',
        label: 'Fallback servers first in core config',
        type: 'boolean',
        optional: true,
      },
    ],
  },
  {
    kind: 'dns-servers',
    title: 'DNS server(s)',
    group: 'Outbounds',
    category: 'rule',
    summary: 'One or more UDP, TCP, DoH or local resolvers',
    defaults: { servers: JSON.stringify([newDnsServer('server-1')]) },
    fields: [
      { key: 'servers', label: 'DNS servers', type: 'json', jsonShape: 'array', maxLength: 524288 },
    ],
  },
];
export const isNativeDnsHandler = (data: RuleNodeData) => data.kind === 'dns-handler';
export const isDnsEditor = (data: RuleNodeData) =>
  isNativeDnsHandler(data) || data.kind === 'dns-routing-filter' || data.kind === 'dns-servers';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !jsonArray(v);
const text = (v: unknown, max = 16384): v is string => typeof v === 'string' && v.length <= max;
const integer = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
function rows(raw: SettingValue, max: number): Record<string, unknown>[] {
  const value: unknown = parseJson(String(raw));
  if (!jsonArray(value) || value.length > max) throw new Error(`Use at most ${max} entries.`);
  const ids = new Set<string>();
  for (const row of value) {
    if (
      !object(row) ||
      !text(row.id, 128) ||
      !/^[a-zA-Z0-9_-]+$/.test(row.id) ||
      ids.has(row.id) ||
      !text(row.name, 128)
    )
      throw new Error('Invalid or duplicate entry identity.');
    ids.add(row.id);
  }
  return value as Record<string, unknown>[];
}
export function readDnsServers(settings: Record<string, SettingValue>): DnsServer[] {
  const value = rows(settings.servers, 32);
  if (!value.length) throw new Error('Keep at least one DNS server.');
  for (const r of value)
    if (
      typeof r.enabled !== 'boolean' ||
      !text(r.address, 4096) ||
      !integer(r.port, 1, 65535) ||
      !families.includes(r.queryStrategy as (typeof families)[number]) ||
      !text(r.clientIP, 128) ||
      !integer(r.timeoutMs, 1, 600000) ||
      !['inherit', 'enabled', 'disabled'].includes(String(r.cache)) ||
      !['inherit', 'enabled', 'disabled'].includes(String(r.stale)) ||
      !integer(r.staleTTL, 0, 4294967295)
    )
      throw new Error('Invalid DNS server settings.');
  return value as unknown as DnsServer[];
}
export function readDnsFilter(settings: Record<string, SettingValue>): DnsFilter {
  const outputs = rows(settings.outputs, 16),
    rules = rows(settings.rules, 128);
  if (
    outputs.some((o) => typeof o.fallback !== 'boolean' || o.id === FAKE_DNS_PORT) ||
    outputs.filter((o) => o.fallback).length !== 1
  )
    throw new Error('Keep exactly one Fallback output and up to 15 named resolver outputs.');
  for (const r of rules) {
    if (
      typeof r.enabled !== 'boolean' ||
      !text(r.output, 128) ||
      !outputs.some((o) => o.id === r.output) ||
      !text(r.domains) ||
      !text(r.expectedIPs) ||
      !text(r.unexpectedIPs) ||
      typeof r.skipFallback !== 'boolean' ||
      typeof r.finalQuery !== 'boolean'
    )
      throw new Error('Invalid DNS preference rule.');
    if (r.source !== undefined) validateDnsSourceRow(r.source);
  }
  if (
    !['always', 'when-unmatched', 'disabled'].includes(String(settings.fallbackMode)) ||
    typeof settings.parallel !== 'boolean' ||
    (settings.fallbackFirst !== undefined && typeof settings.fallbackFirst !== 'boolean')
  )
    throw new Error('Invalid DNS fallback policy.');
  return {
    // Keep the stored port identity when a connected node is edited. Its name and role are fixed.
    outputs: outputs.map((o) =>
      o.fallback ? { ...o, name: 'Fallback' } : o,
    ) as unknown as DnsOutput[],
    rules: rules as unknown as DnsRoute[],
    fallbackMode: String(settings.fallbackMode),
    parallel: settings.parallel,
    ...(settings.ruleSource
      ? { source: validateRuleSource(parseJson(String(settings.ruleSource))) }
      : {}),
    ...(settings.fallbackFirst !== undefined ? { fallbackFirst: settings.fallbackFirst } : {}),
  };
}
export function dnsFilterSettings(filter: DnsFilter): Record<string, SettingValue> {
  return {
    outputs: JSON.stringify(filter.outputs),
    rules: JSON.stringify(filter.rules),
    fallbackMode: filter.fallbackMode,
    parallel: filter.parallel,
    ...(filter.fallbackFirst !== undefined ? { fallbackFirst: filter.fallbackFirst } : {}),
    ruleSource: filter.source ? JSON.stringify(filter.source) : '',
  };
}
export function readDnsPolicies(settings: Record<string, SettingValue>): DnsPolicy[] {
  const value = rows(settings.policyRules, 128);
  for (const r of value)
    if (
      typeof r.enabled !== 'boolean' ||
      !text(r.domain) ||
      !text(r.qType, 4096) ||
      !['resolve', 'forward', 'return', 'drop'].includes(String(r.action)) ||
      !integer(r.rCode, 0, 65535)
    )
      throw new Error('Invalid DNS query policy.');
  return value as unknown as DnsPolicy[];
}
export function dnsOutputs(data: RuleNodeData): { id: string; name: string }[] {
  try {
    if (isNativeDnsHandler(data))
      return [
        { id: 'resolver', name: 'Resolver' },
        ...(dnsUsesForward(data) ? [{ id: 'forward', name: 'Forward queries' }] : []),
      ];
    if (data.kind === 'dns-routing-filter')
      return [...readDnsFilter(data.settings).outputs, { id: FAKE_DNS_PORT, name: 'FakeDNS' }];
    if (data.kind === 'dns-servers')
      return readDnsServers(data.settings).some((s) => s.enabled && !isLocalResolver(s.address))
        ? [{ id: 'queries', name: 'Query traffic' }]
        : [];
  } catch {
    /* Invalid file or draft is diagnosed separately. */
  }
  return [];
}
export const dnsUsesForward = (data: RuleNodeData) =>
  data.settings.policyDefault === 'forward' ||
  readDnsPolicies(data.settings).some((r) => r.enabled && r.action === 'forward');
export const isLocalResolver = (address: string) =>
  address === 'localhost' || /^(tcp|https|quic)\+local:\/\//i.test(address);
type DnsDiagnosticContext = { graph: GraphState; nodeId: string };

function hasHostnameBootstrap(host: string, context: DnsDiagnosticContext | undefined): boolean {
  if (!context) return false;
  const { graph, nodeId } = context;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const pending = [nodeId],
    seen = new Set<string>(),
    handlers = new Set<RuleNodeData>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.edges.filter((edge) => edge.target === id)) {
      const source = nodes.get(edge.source);
      if (!source) continue;
      if (isNativeDnsHandler(source.data) && edge.sourceHandle === 'resolver')
        handlers.add(source.data);
      else if (source.data.kind === 'dns-routing-filter') pending.push(source.id);
    }
  }
  // Bare DNS hosts keys are full matches in Xray. Only explicit IP mappings
  // prove bootstrap here; aliases, RE2 and geodata still need core resolution.
  return (
    handlers.size > 0 &&
    [...handlers].every((handler) => {
      try {
        const hosts = parseJson(String(handler.settings.hosts));
        if (!jsonRecord(hosts)) return false;
        return Object.entries(hosts).some(([key, value]) => {
          const name = key.startsWith('full:') ? key.slice(5) : key;
          if (name.toLowerCase() !== host.toLowerCase()) return false;
          const targets = jsonArray(value) ? value : [value];
          return targets.length > 0 && targets.every((ip) => typeof ip === 'string' && literal(ip));
        });
      } catch {
        return false;
      }
    })
  );
}

export function dnsProblems(data: RuleNodeData, context?: DnsDiagnosticContext): Diagnostic[] {
  if (!isDnsEditor(data)) return [];
  const issues: Diagnostic[] = [];
  let location: Partial<Diagnostic> = {};
  const add = (
    message: string,
    fieldKey?: string,
    severity: 'error' | 'warning' = 'error',
    focusField?: string,
  ) => issues.push({ ...location, message, fieldKey: focusField ?? fieldKey, severity });
  const domains = (value: string, name: string, fieldKey = 'domains') => {
    for (const d of listEntries(value)) {
      const p = domainProblem(d);
      if (p) add(`${name}: ${p}`, fieldKey);
    }
  };
  const ips = (value: string, name: string, fieldKey: string) => {
    for (const ip of listEntries(value))
      if (ip !== '*' && ipProblem(ip))
        add(`${name}: invalid IP, CIDR or GeoIP entry ${ip}.`, fieldKey);
  };
  try {
    if (data.kind === 'dns-servers') {
      const servers = readDnsServers(data.settings);
      if (!servers.some((s) => s.enabled)) add('Enable at least one DNS server.', 'servers');
      for (const s of servers.filter((s) => s.enabled)) {
        location = { rowId: s.id };
        if (!s.name.trim()) add('Give each active server a name.', 'servers', 'error', 'name');
        const p = dnsAddressProblem(s.address);
        if (p) add(`${s.name}: ${p}`, 'servers', 'error', 'address');
        if (s.clientIP && !literal(s.clientIP))
          add(`${s.name}: EDNS client IP must be an IP literal.`, 'servers', 'error', 'clientIP');
        if (isLocalResolver(s.address))
          add(
            `${s.name}: local mode bypasses Xray traffic routing.`,
            'servers',
            'warning',
            'address',
          );
        if (s.address.includes('://')) {
          const host = new URL(s.address).hostname.replace(/^\[|\]$/g, '');
          if (
            !literal(host) &&
            (isLocalResolver(s.address) || !hasHostnameBootstrap(host, context))
          )
            add(
              isLocalResolver(s.address)
                ? `${s.name}: local-mode hostname lookup uses Windows DNS, not the handler’s static hosts. Use an IP-based resolver URL or ensure Windows can resolve it without returning through this handler.`
                : `${s.name}: configure hostname bootstrap in the handler’s static hosts, or ensure your selected path can resolve it without re-entry.`,
              'servers',
              'warning',
              'address',
            );
        }
      }
    } else if (data.kind === 'dns-routing-filter') {
      const f = readDnsFilter(data.settings),
        names = new Set<string>();
      for (const o of f.outputs) {
        location = { outputId: o.id };
        const name = o.name.trim().toLowerCase();
        if (!name || names.has(name))
          add('Output names must be nonempty and unique.', 'outputs', 'error', 'name');
        names.add(name);
      }
      for (const r of f.rules.filter((r) => r.enabled)) {
        location = { rowId: r.id };
        if (!r.name.trim()) add('Give every active preference a name.', 'rules', 'error', 'name');
        if (!listEntries(r.domains).length)
          add(
            `${r.name}: enter a domain preference; use Fallback for unmatched names.`,
            'rules',
            'error',
            'domains',
          );
        domains(r.domains, r.name);
        ips(r.expectedIPs, `${r.name} expected IPs`, 'expectedIPs');
        ips(r.unexpectedIPs, `${r.name} rejected IPs`, 'unexpectedIPs');
      }
      location = {};
      const synthetic = context?.graph.edges.some(
        (e) => e.source === context.nodeId && e.sourceHandle === FAKE_DNS_PORT,
      );
      if (synthetic) {
        const fallback = f.outputs.find((o) => o.fallback)!;
        const edge = context!.graph.edges.find(
          (e) => e.source === context!.nodeId && e.sourceHandle === fallback.id,
        );
        if (context!.graph.nodes.find((n) => n.id === edge?.target)?.data.kind !== 'dns-servers')
          add(
            'FakeDNS needs a real DNS server on Fallback for real-address lookups.',
            'fallbackMode',
            'error',
          );
      }
      if (!synthetic && f.fallbackMode === 'disabled')
        add(
          'Xray uses its first configured server when no preference matches, even with fallback disabled.',
          'fallbackMode',
          'warning',
        );
    } else {
      const s = data.settings;
      if (!String(s.tag).trim()) add('Give the handler a tag.', 'tag');
      if (
        !families.slice(1).includes(s.queryStrategy as 'UseIP') ||
        !['forward', 'return', 'drop'].includes(String(s.policyDefault)) ||
        !integer(s.policyRCode, 0, 65535) ||
        !integer(s.serveExpiredTTL, 0, 4294967295) ||
        !integer(s.rewritePort, 1, 65535)
      )
        add('Invalid handler address family, response code, TTL or forward port.');
      if (
        ['disableCache', 'serveStale', 'useSystemHosts'].some(
          (key) => typeof s[key] !== 'boolean',
        ) ||
        !['udp', 'tcp'].includes(String(s.rewriteNetwork))
      )
        add('Invalid handler resolver policy.');
      if (s.clientIP && !literal(String(s.clientIP)))
        add('EDNS client IP must be an IP literal.', 'clientIP');
      let hosts: unknown;
      try {
        hosts = parseJson(String(s.hosts));
      } catch {
        add('Static hosts must be a JSON object.', 'hosts');
      }
      if (hosts !== undefined) {
        if (!object(hosts)) add('Static hosts must be a JSON object.', 'hosts');
        else
          for (const [key, value] of Object.entries(hosts)) {
            domains(key, 'Static host key', 'hosts');
            const targets = jsonArray(value) ? value : [value];
            if (!targets.length || targets.some((t) => !text(t, 4096) || !t.trim() || /\s/.test(t)))
              add(`Invalid static host target for ${key}.`, 'hosts');
            if (targets.length > 1 && targets.some((t) => !literal(String(t))))
              add(`Multiple host targets for ${key} must be IP literals.`, 'hosts');
          }
      }
      const policies = readDnsPolicies(s);
      for (const [index, r] of policies.entries()) {
        location = { rowId: r.id };
        if (r.enabled) {
          if (!r.name.trim())
            add('Give every active policy a name.', 'policyRules', 'error', 'name');
          domains(r.domain, r.name, 'domain');
          const p = portRangeProblem(r.qType, 0);
          if (p) add(`${r.name}: ${p}`, 'policyRules', 'error', 'qType');
          if (
            r.action === 'resolve' &&
            !['1', '28', '1,28', '28,1'].includes(r.qType.replace(/\s/g, ''))
          )
            add(
              `${r.name}: built-in resolution supports A (1) and AAAA (28).`,
              'policyRules',
              'error',
              'qType',
            );
          if (
            !r.qType.trim() &&
            !r.domain.trim() &&
            policies.slice(index + 1).some((next) => next.enabled)
          )
            add(
              `${r.name}: this catch-all hides later policies.`,
              'policyRules',
              'warning',
              'qType',
            );
        }
      }
      location = {};
      if (dnsUsesForward(data) && !literal(String(s.rewriteAddress)))
        add('Forwarded queries need an explicit UDP/TCP IP address.', 'rewriteAddress');
    }
  } catch (error) {
    add(error instanceof Error ? error.message : 'Invalid DNS configuration.');
  }
  return issues;
}

export interface DnsFragment {
  dns: Record<string, unknown> & { servers: Record<string, unknown>[] };
  outbounds: Record<string, unknown>[];
  routing: { rules: Record<string, unknown>[]; balancers?: Record<string, unknown>[] };
  observatory?: unknown;
  burstObservatory?: unknown;
  fakedns?: unknown;
}
export function compileDnsGraph(
  graph: GraphState,
  options: { includePolicies?: boolean; resourcesResolved?: boolean } = {},
): DnsFragment {
  graph = enabledInboundGraph(graph);
  graph = resolveGraph(options.resourcesResolved ? graph : resourceCompilationGraph(graph));
  const managedFakeDns = automaticFakeDns(graph);
  const handlers = graph.nodes.filter((n) => isNativeDnsHandler(n.data));
  if (handlers.length !== 1)
    throw new Error(
      'The DNS fragment needs exactly one native DNS handler: Xray has one global DNS module.',
    );
  const handler = handlers[0],
    s = handler.data.settings;
  const capturedSystemDns = managedFakeDns && capturesSystemDns(graph, handler.id);
  const check = (data: RuleNodeData) => {
    const issues = dnsProblems(data).filter((i) => i.severity === 'error');
    if (issues.length) throw new Error(`${data.label}: ${issues.map((i) => i.message).join(' ')}`);
  };
  check(handler.data);
  const connected = (id: string, port: string) => {
    const edges = graph.edges.filter((e) => e.source === id && e.sourceHandle === port);
    const target = edges.length === 1 && graph.nodes.find((n) => n.id === edges[0].target);
    if (!target)
      throw new Error(
        `Connect ${graph.nodes.find((n) => n.id === id)?.data.label ?? id}: ${port}.`,
      );
    return target;
  };
  const routing: Record<string, unknown>[] = [],
    outbounds = new Map<string, Record<string, unknown>>();
  const reserved = 'wayrill-dns-';
  if (graph.nodes.some((n) => String(n.data.settings.tag ?? '').startsWith('wayrill-runtime-')))
    throw new Error('Tags starting wayrill-runtime- are reserved for generated outbound paths.');
  if (graph.nodes.some((n) => String(n.data.settings.tag ?? '').startsWith(reserved)))
    throw new Error(`Tags starting ${reserved} are reserved for generated DNS paths.`);
  const addOutbound = (data: RuleNodeData, seen = new Set<string>()) => {
    if (!isExecutableOutboundKind(data.kind) && data.kind !== 'xray-outbound')
      throw new Error('DNS query traffic must end at a configured outbound.');
    const tag = String(data.settings.tag);
    const errors = outboundProblems(data).filter((i) => i.severity === 'error');
    if (errors.length) throw new Error(`${data.label}: ${errors.map((i) => i.message).join(' ')}`);
    if (tag.startsWith(reserved))
      throw new Error(`Outbound tags starting ${reserved} are reserved for generated DNS paths.`);
    if (seen.has(tag)) throw new Error('Dial-through outbounds create a loop.');
    if (
      graph.nodes.filter(
        (n) =>
          (isExecutableOutboundKind(n.data.kind) || n.data.kind === 'xray-outbound') &&
          n.data.settings.tag === tag,
      ).length !== 1 ||
      tag === String(s.tag)
    )
      throw new Error(`Outbound tag ${tag} must be unique, including the DNS handler.`);
    if (!outbounds.has(tag)) {
      const bundle = data.kind === 'xray-outbound' ? [nativeConfig(data)] : outboundBundle(data);
      for (const outbound of bundle) outbounds.set(String(outbound.tag), outbound);
      const native = data.kind === 'xray-outbound' ? nativeConfig(data) : undefined;
      const via =
        data.settings.dialerProxy ||
        (native?.streamSettings as { sockopt?: { dialerProxy?: string } })?.sockopt?.dialerProxy ||
        (native?.proxySettings as { tag?: string })?.tag;
      if (via) {
        const target = graph.nodes.find(
          (n) =>
            (isExecutableOutboundKind(n.data.kind) || n.data.kind === 'xray-outbound') &&
            n.data.settings.tag === via,
        );
        if (!target) throw new Error(`Define dial-through outbound ${via}.`);
        addOutbound(target.data, new Set([...seen, tag]));
      }
    }
    return tag;
  };
  const servers: Record<string, unknown>[] = [];
  const addGroup = (id: string, rule?: DnsRoute) => {
    const group = graph.nodes.find((n) => n.id === id);
    if (group?.data.kind === 'fakedns') {
      const problems = fakeDnsNodeProblems(group.data);
      if (problems.length) throw new Error(problems[0].message);
      const entries = fakeDnsServers(group.data);
      for (const [index, entry] of entries.entries())
        servers.push({
          ...(typeof entry === 'string' ? { address: entry } : (entry as Record<string, unknown>)),
          ...(rule
            ? {
                domains: listEntries(rule.domains),
                skipFallback: rule.skipFallback,
                ...(rule.expectedIPs ? { expectedIPs: listEntries(rule.expectedIPs) } : {}),
                ...(rule.unexpectedIPs ? { unexpectedIPs: listEntries(rule.unexpectedIPs) } : {}),
                // A terminal FakeDNS preference would truncate real-address
                // lookups before the core skips FakeDNS for FakeEnable=false.
                ...(rule.finalQuery ? { finalQuery: index === entries.length - 1 } : {}),
              }
            : {}),
          ...(managedFakeDns ? { finalQuery: false } : {}),
        });
      return;
    }
    if (!group || group.data.kind !== 'dns-servers')
      throw new Error('A DNS preference must connect to DNS server(s).');
    check(group.data);
    const active = readDnsServers(group.data.settings).filter((e) => e.enabled);
    let destination: Record<string, string> = {};
    if (active.some((e) => !isLocalResolver(e.address))) {
      const target = connected(id, 'queries');
      destination =
        target.data.kind === 'policy-group'
          ? { balancerTag: String(target.data.settings.tag) }
          : { outboundTag: addOutbound(target.data) };
    }
    for (const [index, entry] of active.entries()) {
      if (capturedSystemDns && entry.address === 'localhost')
        throw new Error(
          `${group.data.label}: localhost uses Windows DNS, which returns to this captured handler. Use a real DNS server, or a local service address such as 127.0.0.1.`,
        );
      const tag = `${reserved}${id}-${entry.id}`;
      if (
        !isLocalResolver(entry.address) &&
        !routing.some((r) => jsonArray(r.inboundTag) && r.inboundTag.includes(tag))
      )
        routing.push({ type: 'field', inboundTag: [tag], ...destination });
      servers.push({
        address: entry.address,
        ...(literal(entry.address) ? { port: entry.port } : {}),
        tag,
        ...(entry.queryStrategy !== 'inherit' ? { queryStrategy: entry.queryStrategy } : {}),
        ...(entry.clientIP ? { clientIp: entry.clientIP } : {}),
        timeoutMs: entry.timeoutMs,
        ...(entry.cache !== 'inherit' ? { disableCache: entry.cache === 'disabled' } : {}),
        ...(entry.stale !== 'inherit' ? { serveStale: entry.stale === 'enabled' } : {}),
        ...(entry.staleTTL ? { serveExpiredTTL: entry.staleTTL } : {}),
        ...(rule
          ? {
              domains: listEntries(rule.domains),
              skipFallback: rule.skipFallback,
              finalQuery: rule.finalQuery && index === active.length - 1,
              ...(rule.expectedIPs.trim() ? { expectedIPs: listEntries(rule.expectedIPs) } : {}),
              ...(rule.unexpectedIPs.trim()
                ? { unexpectedIPs: listEntries(rule.unexpectedIPs) }
                : {}),
            }
          : { skipFallback: false }),
      });
    }
  };
  const selector = connected(handler.id, 'resolver');
  let resolverOptions: Record<string, unknown> = {};
  if (selector.data.kind === 'dns-routing-filter') {
    check(selector.data);
    const f = readDnsFilter(selector.data.settings);
    const synthetic = graph.edges.find(
      (e) => e.source === selector.id && e.sourceHandle === FAKE_DNS_PORT,
    );
    if (synthetic && graph.nodes.find((n) => n.id === synthetic.target)?.data.kind !== 'fakedns')
      throw new Error('Connect the FakeDNS output to a FakeDNS node.');
    const fallbackOutput = f.outputs.find((o) => o.fallback)!;
    if (synthetic && connected(selector.id, fallbackOutput.id).data.kind !== 'dns-servers')
      throw new Error('FakeDNS needs a real DNS server on Fallback for real-address lookups.');
    const fallback = () => {
      if (synthetic || f.fallbackMode !== 'disabled')
        for (const output of f.outputs.filter((o) => o.fallback))
          addGroup(connected(selector.id, output.id).id);
    };
    if (!synthetic && f.fallbackFirst) fallback();
    for (const rule of f.rules.filter((r) => r.enabled))
      addGroup(connected(selector.id, rule.output).id, rule);
    if (synthetic) {
      // This port selects the pool, not its advanced native resolver entries.
      servers.push({
        address: 'fakedns',
        domains: ['regexp:.*'],
        skipFallback: true,
        finalQuery: false,
      });
    }
    if (synthetic || !f.fallbackFirst) fallback();
    resolverOptions = {
      disableFallback: !synthetic && f.fallbackMode === 'disabled',
      disableFallbackIfMatch: !synthetic && f.fallbackMode === 'when-unmatched',
      // Xray parallel mode starts fallback requests eagerly, even when the
      // synthetic client answer wins. Preserve the authored preference in graph.
      enableParallelQuery: !synthetic && f.parallel,
    };
  } else addGroup(selector.id);
  if (!servers.length || servers.length > 1024)
    throw new Error('The DNS fragment needs 1–1024 expanded server entries.');
  const policy = readDnsPolicies(s)
    .filter((r) => r.enabled)
    .map((r) => ({
      action: r.action === 'resolve' ? 'hijack' : r.action === 'forward' ? 'direct' : r.action,
      ...(r.domain.trim() ? { domain: listEntries(r.domain) } : {}),
      ...(r.qType.trim() ? { qType: r.qType.replace(/\s/g, '') } : {}),
      ...(r.action === 'return' ? { rCode: r.rCode } : {}),
    }));
  policy.push({
    action: s.policyDefault === 'forward' ? 'direct' : String(s.policyDefault),
    ...(s.policyDefault === 'return' ? { rCode: Number(s.policyRCode) } : {}),
  });
  const settings: Record<string, unknown> = { rules: policy };
  if (dnsUsesForward(handler.data)) {
    const forward = connected(handler.id, 'forward');
    addOutbound(forward.data);
    settings.rewriteNetwork = s.rewriteNetwork;
    settings.rewriteAddress = s.rewriteAddress;
    settings.rewritePort = s.rewritePort;
    settings.userLevel = 0;
  }
  const dnsOutbound: Record<string, unknown> = {
    tag: s.tag,
    protocol: 'dns',
    settings,
    ...(dnsUsesForward(handler.data)
      ? {
          streamSettings: {
            sockopt: { dialerProxy: String(connected(handler.id, 'forward').data.settings.tag) },
          },
        }
      : {}),
  };
  let policies;
  if (
    options.includePolicies !== false &&
    graph.nodes.some((n) => n.data.kind === 'policy-group')
  ) {
    for (const node of graph.nodes.filter(
      (n) => isExecutableOutboundKind(n.data.kind) || n.data.kind === 'xray-outbound',
    ))
      addOutbound(node.data);
    policies = compilePolicies(graph, [dnsOutbound, ...outbounds.values()]);
    for (const outbound of policies.outbounds) outbounds.set(String(outbound.tag), outbound);
  }
  const pools = compileFakeDnsPools(graph);
  return {
    ...(pools === undefined ? {} : { fakedns: pools }),
    ...(policies?.observation ?? {}),
    dns: {
      servers,
      tag: `${reserved}global`,
      queryStrategy: s.queryStrategy,
      disableCache: s.disableCache,
      hosts: parseJson(String(s.hosts)),
      useSystemHosts: s.useSystemHosts,
      serveStale: s.serveStale,
      serveExpiredTTL: s.serveExpiredTTL,
      ...(s.clientIP ? { clientIp: s.clientIP } : {}),
      ...resolverOptions,
    },
    outbounds: [dnsOutbound, ...outbounds.values()],
    routing: {
      rules: [...(policies?.rules ?? []), ...routing],
      ...(policies?.balancers.length ? { balancers: policies.balancers } : {}),
    },
  };
}

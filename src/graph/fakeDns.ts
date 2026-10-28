import { coreDefaultHint } from './coreDefaults';
import { ipProblem, isIpLiteral } from './addressValidation';
import { prefixesOverlap } from './ipNetwork';
import {
  checkJson,
  jsonEqual,
  jsonRecord,
  parseXrayJson,
  valueAt,
  jsonText,
  jsonArray,
} from './xrayJson';
import type { Diagnostic, GraphState, NodeDefinition, RuleNodeData } from './types';

export const FAKE_DNS_PORT = 'fakedns';

/** A dedicated link opts into the safe automatic client-answer workflow. */
export function automaticFakeDns(graph: GraphState): boolean {
  const filters = new Set(
    graph.edges
      .filter(
        (edge) =>
          edge.sourceHandle === 'resolver' &&
          graph.nodes.some((n) => n.id === edge.source && n.data.kind === 'dns-handler'),
      )
      .map((edge) => edge.target),
  );
  return graph.edges.some(
    (edge) =>
      filters.has(edge.source) &&
      edge.sourceHandle === FAKE_DNS_PORT &&
      graph.nodes.some((n) => n.id === edge.source && n.data.kind === 'dns-routing-filter') &&
      graph.nodes.some((n) => n.id === edge.target && n.data.kind === 'fakedns'),
  );
}

export function applyAutomaticFakeDnsSettings(
  graph: GraphState,
  config: Record<string, unknown>,
): void {
  if (!automaticFakeDns(graph)) return;
  for (const input of jsonArray(config.inbounds) ? config.inbounds : []) {
    if (!jsonRecord(input)) continue;
    const sniff = jsonRecord(input.sniffing) ? input.sniffing : {};
    input.sniffing = {
      ...sniff,
      enabled: true,
      ...(sniff.enabled === true ? {} : { metadataOnly: true }),
      destOverride: [
        ...new Set([
          ...(sniff.enabled === true && jsonArray(sniff.destOverride) ? sniff.destOverride : []),
          'fakedns',
        ]),
      ],
    };
  }
  // Windows DNS can itself return our synthetic answers. Direct must resolve
  // recovered names with FakeEnable=false through Xray's real DNS fallback.
  for (const outbound of jsonArray(config.outbounds) ? config.outbounds : []) {
    if (!jsonRecord(outbound) || outbound.protocol !== 'freedom') continue;
    const stream = jsonRecord(outbound.streamSettings) ? outbound.streamSettings : {};
    const socket = jsonRecord(stream.sockopt) ? stream.sockopt : {};
    const strategy = typeof socket.domainStrategy === 'string' ? socket.domainStrategy : 'AsIs';
    // AsIs through another outbound preserves remote resolution. Explicit UseIP
    // strategies resolve before dial-through too and must not fall back to Windows.
    const chained =
      socket.dialerProxy || (jsonRecord(outbound.proxySettings) && outbound.proxySettings.tag);
    if (chained && strategy === 'AsIs') continue;
    const forced = strategy === 'AsIs' ? 'ForceIP' : strategy.replace(/^Use/, 'Force');
    if (forced === strategy) continue;
    outbound.streamSettings = {
      ...stream,
      sockopt: { ...socket, domainStrategy: forced },
    };
  }
}

export function fakeDnsAddressConflicts(inputs: unknown, pools: unknown): Diagnostic[] {
  if (!jsonArray(inputs)) return [];
  const ranges = jsonArray(pools) ? pools : [pools];
  const issues: Diagnostic[] = [];
  for (const input of inputs) {
    if (
      !jsonRecord(input) ||
      input.protocol !== 'tun' ||
      !jsonRecord(input.settings) ||
      !jsonArray(input.settings.gateway)
    )
      continue;
    for (const gateway of input.settings.gateway) {
      if (typeof gateway !== 'string') continue;
      for (const pool of ranges) {
        if (
          !jsonRecord(pool) ||
          typeof pool.ipPool !== 'string' ||
          !prefixesOverlap(gateway, pool.ipPool)
        )
          continue;
        issues.push({
          severity: 'warning',
          fieldKey: 'json',
          message: `${typeof input.tag === 'string' ? input.tag : 'TUN'}: adapter range ${gateway} overlaps FakeDNS pool ${pool.ipPool}. Choose an adapter range outside the synthetic pools.`,
        });
      }
    }
  }
  return issues;
}

export const fakeDnsDefinition: NodeDefinition = {
  kind: 'fakedns',
  title: 'FakeDNS',
  category: 'outbound',
  group: 'Outbounds',
  summary: 'Synthetic DNS answers and shared IPv4/IPv6 domain-recovery pools',
  defaults: { pools: '', servers: '["fakedns"]' },
  fields: [
    {
      key: 'pools',
      label: 'Shared FakeDNS pools',
      type: 'textarea',
      maxLength: 131072,
      help: 'Blank uses the core pools selected by the DNS handler’s address family. Custom pools are shared by all FakeDNS nodes.',
    },
    {
      key: 'servers',
      label: 'Resolver entries',
      type: 'json',
      jsonShape: 'array',
      maxLength: 131072,
    },
  ],
};
export const isFakeDnsAddress = (address: unknown) =>
  typeof address === 'string' && address.toLowerCase() === 'fakedns';
export function fakeDnsServers(data: RuleNodeData): unknown[] {
  const value = parseXrayJson(String(data.settings.servers));
  if (
    !jsonArray(value) ||
    value.length > 128 ||
    value.some((s) => !isFakeDnsAddress(jsonRecord(s) ? valueAt(s, ['address']) : s))
  )
    throw new Error(
      'FakeDNS resolver entries must use the fakedns address. Use a DNS server node for network resolvers.',
    );
  return value;
}
export function fakeDnsPools(data: RuleNodeData): unknown {
  const text = String(data.settings.pools ?? '').trim();
  if (!text) return undefined;
  const pools = parseXrayJson(text);
  const rows = jsonArray(pools) ? pools : [pools];
  if (!rows.length || rows.length > 32 || rows.some((p) => !jsonRecord(p)))
    throw new Error('Configure one pool object or an array of 1–32 pool objects.');
  for (const row of rows) {
    const ip = valueAt(row, ['ipPool']),
      size = valueAt(row, ['poolSize']);
    if (
      typeof ip !== 'string' ||
      !ip.includes('/') ||
      ipProblem(ip) ||
      !isIpLiteral(ip.split('/')[0])
    )
      throw new Error('Every FakeDNS pool needs an IPv4 or IPv6 CIDR.');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1)
      throw new Error(
        'Every custom pool needs a positive, exact mapping capacity; the core does not supply missing custom fields.',
      );
    const bits = ip.includes(':') ? 128 : 32,
      prefix = Number(ip.split('/')[1]);
    // The pinned Holder.initialize rejects capacity equal to subnet size too.
    if (BigInt(size) >= 1n << BigInt(bits - prefix))
      throw new Error(
        'Mapping capacity must be smaller than the pool’s address count in the embedded core.',
      );
    if (['127.0.0.0/8', '::1/128', '::ffff:7f00:0/104'].some((local) => prefixesOverlap(ip, local)))
      throw new Error(
        'FakeDNS pools must not overlap loopback addresses; local traffic bypasses capture.',
      );
  }
  for (let index = 0; index < rows.length; index++)
    for (const other of rows.slice(index + 1))
      if (
        prefixesOverlap(
          String(valueAt(rows[index], ['ipPool'])),
          String(valueAt(other, ['ipPool'])),
        )
      )
        throw new Error('FakeDNS pools must not overlap each other.');
  return pools;
}
export function automaticFakeDnsPools(strategy: string): { ipPool: string; poolSize: number }[] {
  const ipv4 = coreDefaultHint('FakeDNS.autoIPv4Pool').text;
  const ipv6 = coreDefaultHint('FakeDNS.autoIPv6Pool').text;
  const normalized = strategy.trim().replace(/[_-]/g, '').toLowerCase();
  const v4 = ['useipv4', 'useip4'].includes(normalized),
    v6 = ['useipv6', 'useip6'].includes(normalized);
  const dual = !v4 && !v6;
  const size = Number(
    coreDefaultHint(dual ? 'FakeDNS.autoDualCapacity' : 'FakeDNS.autoSingleCapacity').text,
  );
  return [
    ...(!v6 ? [{ ipPool: ipv4, poolSize: size }] : []),
    ...(!v4 ? [{ ipPool: ipv6, poolSize: size }] : []),
  ];
}
export function fakeDnsNodeProblems(data: RuleNodeData): Diagnostic[] {
  if (data.kind !== 'fakedns') return [];
  const issues: Diagnostic[] = [];
  for (const [key, check] of [
    ['pools', fakeDnsPools],
    ['servers', fakeDnsServers],
  ] as const) {
    try {
      check(data);
    } catch (e) {
      issues.push({
        severity: 'error',
        fieldKey: key,
        message: e instanceof Error ? e.message : 'Invalid FakeDNS settings.',
      });
    }
  }
  return issues;
}
/** Resolver instances share one native pool module. Edits commit all instances atomically. */
export function editFakeDnsGraph(
  graph: GraphState,
  id: string,
  settings: RuleNodeData['settings'],
): GraphState {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.data.kind === 'fakedns'
        ? {
            ...n,
            data: {
              ...n.data,
              settings: n.id === id ? settings : { ...n.data.settings, pools: settings.pools },
            },
          }
        : n,
    ),
  };
}
export function compileFakeDnsPools(graph: GraphState): unknown {
  const nodes = graph.nodes.filter((n) => n.data.kind === 'fakedns');
  if (!nodes.length) return undefined;
  const pool = fakeDnsPools(nodes[0].data);
  for (const node of nodes) {
    fakeDnsServers(node.data);
    if (!jsonEqual(pool, fakeDnsPools(node.data)))
      throw new Error(
        'FakeDNS nodes must share the same pools. Apply the pool settings in one FakeDNS editor to update them together.',
      );
  }
  return pool;
}
/** Inspect emitted native settings so generic and typed protocol inputs behave alike. */
export function fakeDnsConfigProblems(config: Record<string, unknown>): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const dns = jsonRecord(config.dns) ? config.dns : {};
  const resolvers = jsonArray(dns.servers) ? dns.servers : [];
  const usesFakeDns = resolvers.some((s) =>
    isFakeDnsAddress(jsonRecord(s) ? valueAt(s, ['address']) : s),
  );
  const enabled = config.fakedns !== undefined || usesFakeDns;
  if (enabled)
    issues.push(
      ...fakeDnsAddressConflicts(
        config.inbounds,
        config.fakedns ??
          automaticFakeDnsPools(
            typeof dns.queryStrategy === 'string' ? dns.queryStrategy : 'UseIP',
          ),
      ),
    );
  const inputs = jsonArray(config.inbounds) ? config.inbounds : [];
  let recovery = false;
  for (const input of inputs) {
    if (!jsonRecord(input)) continue;
    const sniff = valueAt(input, ['sniffing']);
    if (!jsonRecord(sniff)) continue;
    const overrides = valueAt(sniff, ['destOverride']);
    const fake =
      jsonArray(overrides) &&
      overrides.some(
        (v) => typeof v === 'string' && ['fakedns', 'fakedns+others'].includes(v.toLowerCase()),
      );
    if (fake && valueAt(sniff, ['enabled']) === true) {
      recovery = true;
      if (
        enabled &&
        ['domainsExcluded', 'ipsExcluded'].some(
          (key) => jsonArray(sniff[key]) && sniff[key].length > 0,
        )
      )
        issues.push({
          severity: 'warning',
          fieldKey: 'sniffFakeDns',
          message: `Input ${jsonText(input.tag ?? '')}: name-detection exclusions also suppress FakeDNS recovery. Resolve excluded destinations with real DNS, or remove the exclusions.`,
        });
      if (!enabled)
        issues.push({
          severity: 'warning',
          fieldKey: 'sniffFakeDns',
          message: `Input ${jsonText(input.tag ?? '')}: FakeDNS recovery is inactive without a FakeDNS resolver/pool in this configuration.`,
        });
    }
  }
  if (usesFakeDns && !recovery)
    issues.push({
      severity: 'warning',
      fieldKey: 'sniffFakeDns',
      message:
        'FakeDNS produces synthetic addresses, but no inbound has enabled FakeDNS domain recovery. Enable recovery on inputs receiving traffic to those addresses.',
    });
  if (config.fakedns !== undefined) {
    const data: RuleNodeData = {
      kind: 'fakedns',
      label: 'FakeDNS',
      description: '',
      settings: { pools: JSON.stringify(config.fakedns), servers: '[]' },
    };
    issues.push(...fakeDnsNodeProblems(data));
  }
  checkJson(config);
  return issues;
}

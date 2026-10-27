import {
  automaticFakeDnsPools,
  compileFakeDnsPools,
  fakeDnsAddressConflicts,
  FAKE_DNS_PORT,
} from './fakeDns';
import { readDnsFilter } from './dns';
import { protocolConfig } from './protocols';
import { addressInPrefix, isLoopbackAddress } from './ipNetwork';
import { jsonArray, jsonRecord } from './xrayJson';
import type { Diagnostic, GraphState } from './types';

/** True only for Windows DNS destinations that actually enter this handler. */
export function capturesSystemDns(graph: GraphState, handlerId: string): boolean {
  for (const node of graph.nodes) {
    if (
      node.data.enabled === false ||
      !['tun-inbound', 'windivert-inbound'].includes(node.data.kind)
    )
      continue;
    if (node.data.kind === 'tun-inbound') {
      let settings: Record<string, unknown>;
      try {
        const config = protocolConfig(node.data);
        if (!jsonRecord(config.settings)) continue;
        settings = config.settings;
      } catch {
        continue;
      }
      const routes = jsonArray(settings.autoSystemRoutingTable)
        ? settings.autoSystemRoutingTable
        : [];
      const dns = jsonArray(settings.dns) ? settings.dns : [];
      const gateways = jsonArray(settings.gateway) ? settings.gateway : [];
      if (
        !dns.some(
          (ip) =>
            typeof ip === 'string' &&
            !isLoopbackAddress(ip) &&
            !gateways.some(
              (g) =>
                typeof g === 'string' &&
                addressInPrefix(ip, `${g.split('/')[0]}/${g.includes(':') ? 128 : 32}`),
            ) &&
            (!routes.length || routes.some((r) => typeof r === 'string' && addressInPrefix(ip, r))),
        )
      )
        continue;
    }
    const pending = graph.edges
      .filter((e) => e.source === node.id && e.sourceHandle === 'dns')
      .map((e) => e.target);
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === handlerId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      if (graph.nodes.find((n) => n.id === id)?.data.kind === 'routing-filter')
        pending.push(...graph.edges.filter((e) => e.source === id).map((e) => e.target));
    }
  }
  return false;
}

/** Inspect only graph topology and small native settings; never compile the
 * subscription/outbound pool just to diagnose adapter DNS. Graph is resolved. */
export function dnsCaptureProblems(graph: GraphState): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const activeHandlers = graph.nodes.filter((n) => n.data.kind === 'dns-handler');
  const filters = new Set(
    graph.edges
      .filter((e) => e.sourceHandle === 'resolver' && activeHandlers.some((h) => h.id === e.source))
      .map((e) => e.target),
  );
  let usesFake = false;
  for (const edge of graph.edges) {
    if (nodes.get(edge.target)?.data.kind !== 'fakedns') continue;
    const source = nodes.get(edge.source);
    if (source?.data.kind === 'dns-handler' || source?.data.kind === 'xray-dns') usesFake = true;
    if (source?.data.kind !== 'dns-routing-filter' || !filters.has(source.id)) continue;
    if (edge.sourceHandle === FAKE_DNS_PORT) {
      usesFake = true;
      continue;
    }
    try {
      const filter = readDnsFilter(source.data.settings);
      usesFake ||=
        filter.rules.some((r) => r.enabled && r.output === edge.sourceHandle) ||
        (filter.fallbackMode !== 'disabled' &&
          filter.outputs.some((o) => o.fallback && o.id === edge.sourceHandle));
    } catch {
      /* Malformed filter drafts have their own diagnostics. */
    }
  }
  let pools: unknown;
  try {
    pools =
      (graph.xray ? undefined : compileFakeDnsPools(graph)) ??
      (usesFake && !graph.xray
        ? automaticFakeDnsPools(String(activeHandlers[0]?.data.settings.queryStrategy ?? 'UseIP'))
        : undefined);
  } catch {
    /* Pool field diagnostics explain malformed settings. */
  }
  for (const node of graph.nodes) {
    if (!['tun-inbound', 'ics-tun'].includes(node.data.kind) || node.data.enabled === false)
      continue;
    let input: Record<string, unknown>;
    try {
      input = protocolConfig(node.data);
    } catch {
      continue;
    }
    if (pools)
      for (const issue of fakeDnsAddressConflicts([input], pools))
        issues.push({ ...issue, nodeId: node.id });
    if (node.data.kind !== 'tun-inbound' || !jsonRecord(input.settings)) continue;
    // DNS may traverse a DNS-only traffic filter before the handler.
    const pending = graph.edges
      .filter((e) => e.source === node.id && e.sourceHandle === 'dns')
      .map((e) => e.target);
    const seen = new Set<string>();
    let handler = false;
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const target = nodes.get(id);
      if (target?.data.kind === 'dns-handler') {
        handler = true;
        break;
      }
      if (target?.data.kind === 'routing-filter')
        pending.push(...graph.edges.filter((e) => e.source === id).map((e) => e.target));
    }
    if (!handler || !jsonArray(input.settings.dns)) continue;
    const gateways = jsonArray(input.settings.gateway)
      ? input.settings.gateway.filter((g): g is string => typeof g === 'string')
      : [];
    const routes = jsonArray(input.settings.autoSystemRoutingTable)
      ? input.settings.autoSystemRoutingTable.filter((r): r is string => typeof r === 'string')
      : [];
    for (const server of input.settings.dns) {
      if (typeof server !== 'string') continue;
      const local =
        isLoopbackAddress(server) ||
        gateways.some((g) =>
          addressInPrefix(server, `${g.split('/')[0]}/${g.includes(':') ? 128 : 32}`),
        );
      const outside =
        !local && routes.length > 0 && !routes.some((r) => addressInPrefix(server, r));
      if (local || outside)
        issues.push({
          severity: 'warning',
          nodeId: node.id,
          fieldKey: 'json',
          message: `${node.data.label}: adapter DNS ${server} ${local ? 'stays local' : 'is outside the captured routes'} and bypasses the connected DNS handler${usesFake ? ' and FakeDNS' : ''}. Choose a captured DNS destination, such as 1.1.1.1 with full capture. Keep local resolvers in DNS server nodes.`,
        });
    }
  }
  return issues;
}

import { parseJson, parseJsonObject, jsonArray, jsonRecord, jsonText } from './xrayJson';
import { dnsIpLiteral } from './addressValidation';
import { readProxyChain } from './composites';
import type { Diagnostic, GraphState, RuleNode } from './types';

export const isUdpResolver = (address: string) => dnsIpLiteral(address);

/** TCP endpoints carry their port in the URL; the separate core port applies to UDP only. */
export function tcpResolverAddress(address: string, port = 53): string {
  // Xray's UDP resolver treats an explicit zero as the default DNS port too.
  if (port === 0) port = 53;
  if (!isUdpResolver(address) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Choose a valid UDP resolver address and port first.');
  return `tcp://${address.includes(':') ? `[${address}]` : address}:${port}`;
}

function routedPolicies(graph: GraphState, start: RuleNode): string[] {
  const seen = new Set<string>(),
    pending = [start.id],
    names = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) continue;
    if (node.data.kind === 'policy-group') {
      if (
        node.data.settings.fallbackEnabled ||
        ['leastPing', 'leastLoad'].includes(String(node.data.settings.strategy))
      )
        names.add(node.data.label);
      continue;
    }
    if (node.data.kind === 'proxy-chain') {
      try {
        const { steps } = readProxyChain(node.data);
        for (const step of steps)
          if (step.outbound.type === 'node' && step.outbound.nodeId)
            pending.push(step.outbound.nodeId);
      } catch {
        /* The chain editor reports malformed settings. */
      }
    }
    for (const edge of graph.edges.filter(
      (e) => e.source === id && e.sourceHandle !== 'observation',
    ))
      pending.push(edge.target);
  }
  return [...names];
}

/** Warn without rewriting imported or authored resolver transport semantics. */
export function udpDnsPolicyWarnings(graph: GraphState): Diagnostic[] {
  const issues: Diagnostic[] = [];
  for (const node of graph.nodes.filter((n) =>
    ['dns-servers', 'xray-dns-servers'].includes(n.data.kind),
  )) {
    const policies = routedPolicies(graph, node);
    if (!policies.length) continue;
    try {
      const native = node.data.kind === 'xray-dns-servers';
      const rows = native
        ? parseJsonObject(String(node.data.settings.json)).servers
        : parseJson(String(node.data.settings.servers));
      if (!jsonArray(rows)) continue;
      for (const [index, row] of rows.entries()) {
        if (typeof row !== 'string' && !jsonRecord(row)) continue;
        const address = typeof row === 'string' ? row : row.address;
        if (
          (!native && (!jsonRecord(row) || !row.enabled)) ||
          typeof address !== 'string' ||
          !isUdpResolver(address)
        )
          continue;
        issues.push({
          severity: 'warning',
          nodeId: node.id,
          rowId: !native && jsonRecord(row) && typeof row.id === 'string' ? row.id : undefined,
          fieldKey: native ? 'json' : 'address',
          message: `${node.data.label}: ${typeof row === 'string' ? row : jsonText(row.name ?? '') || `Server ${index + 1}`} uses UDP DNS, whose existing session can remain on a failed candidate of ${policies.join(', ')}. Use TCP DNS for policy failover.`,
        });
      }
    } catch {
      /* DNS validation reports malformed entries. */
    }
  }
  return issues;
}

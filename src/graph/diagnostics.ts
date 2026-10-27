import { listenerProblem, listenerEndpointsConflict } from './listeners';
import { enabledInboundGraph, isGraphInbound, isDisabledInbound } from './inboundState';
import { RoutingPathError } from './routingPaths';
import { policyCandidates, readPolicySources, resolvePolicyReference } from './policySources';
import { diagnoseXrayGraph } from './xrayCompiler';
import { loopbackProblems, outboundDependencyProblems } from './protocols';
import { inboundPreview, inboundEndpoints } from './inbounds';
import { compileRuntimeGraph, compileResolvedRuntimeGraph } from './runtime';
import { diagnoseGraph } from './model';
import { getOutputPorts, portLabel } from './catalog';
import { isInboundKind } from './inbounds';
import { isExecutableOutboundKind } from './outbounds';
import { isNativeDnsHandler } from './dns';
import { readRuleTable } from './rules';
import { selectorKey } from './applications';
import { resolveGraph } from './defaults';
import type { Diagnostic, GraphState, RuleNode } from './types';
import { expandCompositeOutbounds, compositeDiagnostics } from './composites';

export function diagnoseRuntimeGraph(source: GraphState, internal = false): Diagnostic[] {
  if (source.xray) {
    const issues = diagnoseXrayGraph(resolveGraph(source));
    if (
      source.nodes.some((n) => isGraphInbound(n.data.kind)) &&
      !source.nodes.some((n) => isGraphInbound(n.data.kind) && !isDisabledInbound(n.data))
    )
      issues.push({
        severity: 'error',
        message: 'Enable at least one inbound or local capture source before running.',
      });
    return issues;
  }
  source = enabledInboundGraph(source);
  try {
    const expansion = expandCompositeOutbounds(resolveGraph(source));
    if (expansion.changed)
      return compositeDiagnostics(expansion, diagnoseRuntimeGraph(expansion.graph, true));
  } catch (error) {
    const p = error as Error & { nodeId?: string; fieldKey?: string };
    return [{ severity: 'error', message: p.message, nodeId: p.nodeId, fieldKey: p.fieldKey }];
  }
  const graph = resolveGraph(source),
    issues = diagnoseGraph(graph),
    byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const add = (
    node: RuleNode | undefined,
    message: string,
    fieldKey?: string,
    severity: Diagnostic['severity'] = 'error',
    location: Partial<Diagnostic> = {},
  ) =>
    issues.push({
      ...location,
      severity,
      nodeId: node?.id,
      fieldKey,
      message: node ? `${node.data.label}: ${message}` : message,
    });
  const inputs = graph.nodes.filter((n) => isInboundKind(n.data.kind));
  if (!inputs.length)
    add(undefined, 'Enable at least one inbound or local capture source before running.');
  else if (inputs.length > 16) add(undefined, 'A runtime graph needs 1–16 enabled Xray inbounds.');
  const path = (node: RuleNode, port: string, allowDns = false, allowFilter = false) => {
    const edge = graph.edges.find((e) => e.source === node.id && e.sourceHandle === port),
      target = edge ? byId.get(edge.target) : undefined;
    if (!target)
      add(
        node,
        `Connect the ${portLabel(port, node.data)} path before running.`,
        undefined,
        'error',
        { portId: port },
      );
    else if (
      !isExecutableOutboundKind(target.data.kind) &&
      target.data.kind !== 'xray-outbound' &&
      target.data.kind !== 'policy-group' &&
      !(allowDns && isNativeDnsHandler(target.data)) &&
      !(allowFilter && target.data.kind === 'routing-filter')
    )
      add(
        node,
        `${portLabel(port, node.data)} must lead to ${allowFilter ? 'a routing filter or ' : ''}a configured outbound or a policy group${allowDns ? ', or a DNS handler' : ''}.`,
        undefined,
        'error',
        { portId: port },
      );
  };
  for (const node of graph.nodes) {
    const tag = String(node.data.settings.tag ?? '');
    if (/^wayrill-(runtime|dns|policy)-/.test(tag))
      add(node, 'This tag prefix is reserved for generated runtime destinations.', 'tag');
    if (isInboundKind(node.data.kind)) {
      for (const port of getOutputPorts(node.data.kind, node.data)) {
        if (
          node.data.kind === 'tun-inbound' &&
          ['dns', 'nat-dns'].includes(port) &&
          !graph.edges.some((e) => e.source === node.id && e.sourceHandle === port)
        )
          continue;
        path(node, port, ['dns', 'nat-dns'].includes(port), true);
      }
      try {
        const native = inboundPreview(node.data);
        if (native.protocol === 'tun') continue;
        const problem = listenerProblem(native);
        if (problem) add(node, problem, problem.startsWith('Listen port') ? 'port' : 'listen');
      } catch {
        /* Protocol diagnostics describe invalid JSON drafts. */
      }
      if (
        graph.nodes.some(
          (other) =>
            other.id !== node.id &&
            isInboundKind(other.data.kind) &&
            inboundEndpoints(node.data).some((e) =>
              inboundEndpoints(other.data).some((otherEndpoint) =>
                listenerEndpointsConflict(e, otherEndpoint),
              ),
            ),
        )
      )
        add(node, 'Another inbound uses an overlapping listen address, port and network.', 'port');
    }
    if (isExecutableOutboundKind(node.data.kind)) {
      const via = String(node.data.settings.dialerProxy ?? '');
      if (
        via &&
        !graph.nodes.some(
          (n) => isExecutableOutboundKind(n.data.kind) && n.data.settings.tag === via,
        )
      )
        add(node, 'Define the dial-through outbound before running.', 'dialerProxy');
      if (graph.nodes.some((n) => isNativeDnsHandler(n.data) && n.data.settings.tag === tag))
        add(node, 'Outbound tag is also used by the DNS handler.', 'tag');
    }
    if (node.data.kind === 'routing-filter') {
      try {
        const table = readRuleTable(node.data.settings),
          active = table.rules.filter((r) => r.enabled);
        path(node, table.defaultOutput, false, true);
        if (table.tunAmbiguity?.action === 'allow' && table.tunAmbiguity.output)
          path(node, table.tunAmbiguity.output, false, true);
        for (const output of new Set(active.map((r) => r.output))) path(node, output, false, true);
        let catchAll = false;
        const predicates = new Set<string>();
        for (const row of active) {
          const predicate = JSON.stringify({
            conditions: Object.entries(row.conditions)
              .filter(([, v]) => v?.trim())
              .sort(([a], [b]) => a.localeCompare(b)),
            applications: selectorKey((row.applications ?? []).filter((r) => r.enabled)),
            targetMatch: row.targetMatch ?? 'any',
          });
          if (catchAll || (!row.matchAll && predicates.has(predicate)))
            add(
              node,
              `${row.name} cannot be reached because an earlier enabled rule matches the same traffic.`,
              'name',
              'warning',
              { rowId: row.id },
            );
          if (row.matchAll) catchAll = true;
          else predicates.add(predicate);
          const inbound = row.conditions.inboundTag;
          if (inbound?.trim()) {
            const incoming = graph.edges
              .filter(
                (e) => e.target === node.id && ['data', 'traffic'].includes(e.sourceHandle ?? ''),
              )
              .map((e) => byId.get(e.source))
              .filter((n): n is RuleNode => !!n && isInboundKind(n.data.kind));
            const tags = inbound.split(/[\n,]/).map((s) => s.trim());
            if (
              incoming.length &&
              !incoming.some((n) => tags.includes(String(n.data.settings.tag)))
            )
              add(
                node,
                `${row.name} excludes every inbound connected to this filter.`,
                'inboundTag',
                'warning',
                { rowId: row.id },
              );
          }
        }
      } catch {
        /* Field validation already reports malformed rule tables. */
      }
    }
  }
  const reachable = new Set<string>(),
    todo = inputs.map((n) => n.id);
  // DNS is a global module and dial-through dependencies do not have canvas wires.
  todo.push(
    ...graph.nodes
      .filter((n) => isNativeDnsHandler(n.data) || n.data.kind === 'observatory')
      .map((n) => n.id),
  );
  while (todo.length) {
    const id = todo.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of graph.edges) if (edge.source === id) todo.push(edge.target);
    const n = byId.get(id);
    if (n?.data.kind === 'policy-group')
      try {
        for (const { node } of policyCandidates(graph, n))
          if (byId.has(node.id)) todo.push(node.id);
        const ref = readPolicySources(n.data).fallback;
        if (n.data.settings.fallbackEnabled && ref) {
          const target = resolvePolicyReference(graph, ref);
          if (byId.has(target.id)) todo.push(target.id);
        }
      } catch {
        /* Source diagnostics already describe broken references. */
      }
    const via = n?.data.settings.dialerProxy;
    if (via) {
      const target = graph.nodes.find((n) => n.data.settings.tag === via);
      if (target) todo.push(target.id);
    }
  }
  for (const node of graph.nodes)
    if (!reachable.has(node.id))
      add(
        node,
        'This node is unreachable from any runtime inbound or global DNS path.',
        undefined,
        'warning',
      );
  if (!issues.some((i) => i.severity === 'error')) {
    try {
      const compiled = internal ? compileResolvedRuntimeGraph(graph) : compileRuntimeGraph(graph);
      for (const issue of [
        ...loopbackProblems(compiled.config),
        ...outboundDependencyProblems(compiled.config).map((p) => ({
          ...p,
          severity: 'error' as const,
        })),
      ])
        add(
          graph.nodes.find(
            (n) => isExecutableOutboundKind(n.data.kind) && n.data.settings.tag === issue.tag,
          ),
          issue.message,
          'json',
          issue.severity,
        );
      for (const warning of compiled.warnings)
        if (!issues.some((i) => i.severity === 'warning' && i.message === warning))
          issues.push({
            severity: 'warning',
            message: warning,
            nodeId: graph.nodes.find((n) => warning.startsWith(`${n.data.label}:`))?.id,
          });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      issues.push({
        severity: 'error',
        message,
        nodeId:
          e instanceof RoutingPathError
            ? e.nodeId
            : graph.nodes.find((n) => message.startsWith(`${n.data.label}:`))?.id,
        fieldKey: e instanceof RoutingPathError ? e.fieldKey : undefined,
      });
    }
  }
  return issues.filter(
    (issue, index, all) =>
      all.findIndex(
        (i) =>
          i.severity === issue.severity &&
          i.nodeId === issue.nodeId &&
          i.message === issue.message &&
          i.fieldKey === issue.fieldKey &&
          i.rowId === issue.rowId &&
          i.outputId === issue.outputId &&
          i.portId === issue.portId,
      ) === index,
  );
}

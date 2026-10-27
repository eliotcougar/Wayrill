import type { Connection, Edge } from '@xyflow/react';
import { getOutputPorts, hasInputPort } from './catalog';
import { typedConnectionProblem } from './connectionTypes';
import type { Diagnostic, GraphState } from './types';

function portProblem(graph: GraphState, connection: Connection | Edge): string | null {
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (!source || !target) return 'This connection refers to a missing node.';
  if (source.id === target.id) return 'A node cannot connect to itself.';
  if (!getOutputPorts(source.data.kind, source.data).includes(connection.sourceHandle ?? '')) {
    return 'This node has no matching output port.';
  }
  if (!hasInputPort(target.data.kind) || connection.targetHandle !== 'in') {
    return 'Connect to an input port on a filter, rule, or output.';
  }
  const typed = typedConnectionProblem(source.data, connection.sourceHandle ?? '', target.data);
  if (typed) return typed;
  if (target.data.kind === 'dns-handler' && source.data.kind === 'routing-filter') {
    const edges = [
      ...graph.edges.filter((edge) => edge.id !== ('id' in connection ? connection.id : undefined)),
      connection,
    ];
    const pending = [source.id],
      seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of edges.filter((item) => item.target === id)) {
        const upstream = graph.nodes.find((node) => node.id === edge.source);
        if (upstream?.data.kind === 'routing-filter') pending.push(upstream.id);
        else if (!['dns', 'nat-dns'].includes(edge.sourceHandle ?? ''))
          return 'A DNS handler needs plaintext DNS only. This filter also receives general or encrypted traffic; use a separate DNS filter path.';
      }
    }
  }
  // Reject adding a general-traffic root to an already connected DNS-handler chain too.
  if (
    target.data.kind === 'routing-filter' &&
    source.data.kind !== 'routing-filter' &&
    !['dns', 'nat-dns'].includes(connection.sourceHandle ?? '')
  ) {
    const pending = [target.id],
      seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of graph.edges.filter((item) => item.source === id)) {
        const downstream = graph.nodes.find((node) => node.id === edge.target);
        if (downstream?.data.kind === 'dns-handler')
          return 'This filter leads to a plaintext DNS handler. Connect the input’s DNS output or choose a separate traffic filter.';
        if (downstream?.data.kind === 'routing-filter') pending.push(downstream.id);
      }
    }
  }
  return null;
}

export function connectionProblem(graph: GraphState, connection: Connection | Edge): string | null {
  const problem = portProblem(graph, connection);
  if (problem) return problem;
  const proposed = {
    ...graph,
    edges: [...graph.edges, { ...connection, id: '__proposed_connection__' }],
  };
  for (const edge of proposed.edges) {
    if (proposed.nodes.find((node) => node.id === edge.target)?.data.kind !== 'dns-handler')
      continue;
    const dnsProblem = portProblem(proposed, edge);
    if (dnsProblem) return dnsProblem;
  }
  if (
    graph.edges.some(
      (edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle,
    )
  ) {
    return 'This output port already has a path. Remove or reconnect it first.';
  }
  const todo = [connection.target],
    visited = new Set<string>();
  while (todo.length) {
    const id = todo.pop()!;
    if (id === connection.source) return 'This connection would create a routing loop.';
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of graph.edges) if (edge.source === id) todo.push(edge.target);
  }
  return null;
}

export function structureProblems(graph: GraphState): Diagnostic[] {
  const issues: Diagnostic[] = [],
    nodeIds = new Set<string>(),
    edgeIds = new Set<string>(),
    ports = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const add = (nodeId: string | undefined, message: string) =>
    issues.push({ severity: 'error', nodeId, message });
  for (const node of graph.nodes) {
    if (
      node.data.kind === 'ics-tun' &&
      graph.nodes.filter((n) => n.data.kind === 'ics-tun').length > 1
    )
      add(node.id, 'Keep only one ICS TUN node, including disabled nodes.');
    if (nodeIds.has(node.id)) add(node.id, 'Duplicate node ID.');
    nodeIds.add(node.id);
  }
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) add(edge.source, 'Duplicate connection ID.');
    edgeIds.add(edge.id);
    const problem = portProblem(graph, edge);
    if (problem) add(nodeIds.has(edge.source) ? edge.source : undefined, problem);
    const key = `${edge.source}:${edge.sourceHandle}`;
    if (ports.has(key)) add(edge.source, 'One output port has multiple paths.');
    ports.add(key);
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
    }
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) {
      add(id, 'A routing loop connects these nodes.');
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) walk(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodeIds) walk(id);
  return issues;
}

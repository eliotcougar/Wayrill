import { mainOutbound } from '../quickSwitch';
import { captureNodeName, nativeValue, protocolJson, setNative } from './protocols';
import { isTunKind } from './tun';
import { isOutboundKind } from './outbounds';
import { icsNodeProblems } from './internetSharing';
import { dnsCaptureProblems } from './dnsCapture';
import { jsonArray, jsonRecord, parseJson } from './xrayJson';
import { enabledInboundGraph, isGraphInbound } from './inboundState';
import { udpDnsPolicyWarnings } from './dnsTransport';
import { parseCaptureOptions } from './capture';
import { diagnoseXrayGraph } from './xrayCompiler';
import { parseNativeProjection, parseXrayMetadata } from './xrayProjection';
import {
  bindingsFor,
  defaultsProblems,
  factoryDefaults,
  parseDefaults,
  parseOverrides,
  resolveGraph,
} from './defaults';
import { connectionProblem, structureProblems } from './structure';
export { connectionProblem } from './structure';
import {
  getDefinition,
  getOutputPorts,
  hasInputPort,
  isNodeKind,
  validateSettings,
  portLabel,
} from './catalog';
import { isExecutableOutboundKind, outboundProblems } from './outbounds';
import { fieldProblem } from './settingValidation';
import { inboundEndpoints, inboundProblems, isInboundKind } from './inbounds';
import { ruleTableProblems } from './rules';
import { policyGraphProblems, policyNeedsObservation, policyProblems } from './policies';
import { policyReferenceSet, readPolicySources } from './policySources';
import { readProxyChain } from './proxyChains';
import { fakeDnsNodeProblems } from './fakeDns';
import { dnsProblems, isNativeDnsHandler } from './dns';
import type {
  Diagnostic,
  GraphDocument,
  GraphState,
  RuleEdge,
  RuleNode,
  RuleNodeData,
} from './types';

export function updateGraphNode(
  graph: GraphState,
  id: string,
  update: Partial<RuleNodeData>,
): GraphState {
  const nodes = graph.nodes.map((node) => {
    if (node.id !== id) return node;
    const data = { ...node.data, ...update };
    if (isTunKind(data.kind) && update.label !== undefined && update.settings === undefined) {
      const raw = protocolJson(data);
      const settings = nativeValue(raw, 'settings');
      data.settings = {
        ...data.settings,
        json: JSON.stringify(
          setNative(
            raw,
            'settings',
            setNative(jsonRecord(settings) ? settings : {}, 'name', update.label),
          ),
          null,
          2,
        ),
      };
    }
    return { ...node, data: { ...data, label: captureNodeName(data) } };
  });
  const updated = nodes.find((node) => node.id === id);
  const ports = updated ? getOutputPorts(updated.data.kind, updated.data) : [];
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter(
      (edge) => edge.source !== id || ports.includes(edge.sourceHandle ?? ''),
    ),
  };
}

export function toDocument(graph: GraphState): GraphDocument {
  graph = graph.defaults
    ? resolveGraph(graph)
    : {
        ...graph,
        defaults: factoryDefaults(),
        nodes: graph.nodes.map((node) => ({
          ...node,
          data: {
            ...node.data,
            overrides: bindingsFor(node.data.kind).map((b) => b.nodeKey),
          },
        })),
      };
  return {
    format: 'wayrill.graph',
    version: 2,
    name: graph.name,
    ...(mainOutbound(graph) ? { mainOutboundId: graph.mainOutboundId } : {}),
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: 'rule',
      position: { ...node.position },
      data: {
        kind: node.data.kind,
        ...(isGraphInbound(node.data.kind) && node.data.enabled === false
          ? { enabled: false }
          : {}),
        label: captureNodeName(node.data),
        description: node.data.description,
        settings: Object.fromEntries(
          Object.keys(node.data.settings)
            .sort()
            .map((key) => [key, node.data.settings[key]]),
        ),
        ...(node.data.overrides ? { overrides: [...node.data.overrides] } : {}),
        ...(node.data.native ? { native: node.data.native } : {}),
        ...(node.data.stashLink ? { stashLink: { ...node.data.stashLink } } : {}),
      },
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    })),
    ...(graph.captureOptions ? { captureOptions: graph.captureOptions } : {}),
    ...(graph.xray ? { xray: graph.xray } : {}),
    ...(graph.viewport ? { viewport: { ...graph.viewport } } : {}),
    ...(graph.defaults
      ? {
          defaults: {
            version: 1,
            settings: { ...graph.defaults.settings },
            ...(graph.defaults.resources ? { resources: graph.defaults.resources } : {}),
          },
        }
      : {}),
  };
}

export const serializeGraph = (graph: GraphState) => JSON.stringify(toDocument(graph), null, 2);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !jsonArray(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

export function parseGraph(text: string): GraphState {
  if (new TextEncoder().encode(text).length > 64 * 1024 * 1024)
    throw new Error('Graph files must be smaller than 64 MiB.');
  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isRecord(raw) || raw.format !== 'wayrill.graph' || raw.version !== 2)
    throw new Error('This is not a supported Wayrill graph file.');
  if (
    !validText(raw.name, 128) ||
    !jsonArray(raw.nodes) ||
    !jsonArray(raw.edges) ||
    raw.nodes.length > 500 ||
    raw.edges.length > 1500
  )
    throw new Error('Invalid graph structure or graph size.');
  if (raw.defaults === undefined)
    throw new Error(
      'Older graph formats are no longer supported: workspace defaults and per-node overrides are required.',
    );
  const defaults = parseDefaults(raw.defaults);
  const ids = new Set<string>();
  const nodes: RuleNode[] = raw.nodes.map((item) => {
    if (
      !isRecord(item) ||
      !validId(item.id) ||
      ids.has(item.id) ||
      !isRecord(item.position) ||
      !isRecord(item.data) ||
      !isNodeKind(item.data.kind) ||
      !validText(item.data.label, 128) ||
      !validText(item.data.description, 4096)
    )
      throw new Error('Invalid or duplicate node.');
    const { x, y } = item.position;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 100000 ||
      Math.abs(y) > 100000
    )
      throw new Error('Invalid node position.');
    ids.add(item.id);
    if (
      item.data.enabled !== undefined &&
      (typeof item.data.enabled !== 'boolean' || !isGraphInbound(item.data.kind))
    )
      throw new Error('Only inbounds can have a boolean enabled state.');
    const settings = validateSettings(item.data.kind, item.data.settings);
    const overrides = parseOverrides(item.data.kind, item.data.overrides);
    const native =
      item.data.native === undefined ? undefined : parseNativeProjection(item.data.native);
    const stashLink = item.data.stashLink;
    if (
      stashLink !== undefined &&
      (!isRecord(stashLink) ||
        ![stashLink.groupId, stashLink.entryId].every(
          (v) => typeof v === 'string' && v.length > 0 && v.length <= 128,
        ))
    )
      throw new Error('Invalid Stash link.');
    return {
      id: item.id,
      type: 'rule',
      position: { x, y },
      data: {
        kind: item.data.kind,
        ...(item.data.enabled === false ? { enabled: false } : {}),
        settings,
        overrides,
        ...(native ? { native } : {}),
        ...(stashLink
          ? {
              stashLink: { groupId: String(stashLink.groupId), entryId: String(stashLink.entryId) },
            }
          : {}),
        label: item.data.label,
        description: item.data.description,
      },
    };
  });
  for (const node of nodes) node.data.label = captureNodeName(node.data);
  if (nodes.filter((n) => n.data.kind === 'ics-tun').length > 1)
    throw new Error('Keep only one ICS TUN node, including disabled nodes.');
  if (
    raw.mainOutboundId !== undefined &&
    (!validId(raw.mainOutboundId) ||
      !nodes.some((node) => node.id === raw.mainOutboundId && isOutboundKind(node.data.kind)))
  )
    throw new Error('Main must refer to an existing outbound, policy group or proxy chain.');
  const graph: GraphState = {
    ...(raw.mainOutboundId === undefined ? {} : { mainOutboundId: raw.mainOutboundId }),
    name: raw.name,
    defaults,
    nodes,
    edges: [],
    ...(raw.xray === undefined ? {} : { xray: parseXrayMetadata(raw.xray) }),
  };
  if (
    !graph.xray &&
    nodes.some(
      (n) =>
        n.data.native &&
        !n.data.kind.endsWith('outbound') &&
        !['policy-group', 'proxy-chain'].includes(n.data.kind),
    )
  )
    throw new Error('Native Xray projections require imported configuration metadata.');
  const edgeIds = new Set<string>();
  for (const item of raw.edges) {
    if (
      !isRecord(item) ||
      !validId(item.id) ||
      edgeIds.has(item.id) ||
      !validId(item.source) ||
      !validId(item.target) ||
      typeof item.sourceHandle !== 'string' ||
      typeof item.targetHandle !== 'string'
    )
      throw new Error('Invalid or duplicate connection.');
    const edge: RuleEdge = {
      id: item.id,
      source: item.source,
      target: item.target,
      sourceHandle: item.sourceHandle,
      targetHandle: item.targetHandle,
    };
    const problem = connectionProblem(graph, edge);
    if (problem) throw new Error(problem);
    edgeIds.add(item.id);
    graph.edges.push(edge);
  }
  if (raw.viewport !== undefined) {
    if (!isRecord(raw.viewport)) throw new Error('Invalid canvas view.');
    const { x, y, zoom } = raw.viewport;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof zoom !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(zoom) ||
      Math.abs(x) > 100000 ||
      Math.abs(y) > 100000 ||
      zoom < 0.25 ||
      zoom > 2
    )
      throw new Error('Invalid canvas view.');
    graph.viewport = { x, y, zoom };
  }
  if (raw.captureOptions !== undefined)
    graph.captureOptions = parseCaptureOptions(raw.captureOptions);
  return resolveGraph(graph);
}

import { expandCompositeOutbounds, compositeDiagnostics } from './composites';

export function diagnoseGraph(graph: GraphState): Diagnostic[] {
  const duplicates = graph.nodes.filter((n) => n.data.kind === 'ics-tun');
  if (duplicates.length > 1)
    return duplicates.map((n) => ({
      severity: 'error',
      nodeId: n.id,
      message: 'Keep only one ICS TUN node, including disabled nodes.',
    }));
  if (!graph.xray) graph = enabledInboundGraph(graph);
  try {
    const expansion = expandCompositeOutbounds(resolveGraph(graph));
    if (expansion.changed) return compositeDiagnostics(expansion, diagnoseGraph(expansion.graph));
  } catch (error) {
    const problem = error as Error & { nodeId?: string; fieldKey?: string };
    return [
      {
        severity: 'error',
        message: problem.message,
        nodeId: problem.nodeId,
        fieldKey: problem.fieldKey,
      },
    ];
  }
  if (graph.xray) {
    const resolved = resolveGraph(graph);
    return [...diagnoseXrayGraph(resolved), ...dnsCaptureProblems(resolved)];
  }
  graph = resolveGraph(graph);
  const issues: Diagnostic[] = [
    ...(graph.defaults
      ? defaultsProblems(graph.defaults).map((issue) => ({ ...issue, scope: 'defaults' as const }))
      : []),
    ...structureProblems(graph),
    ...icsNodeProblems(graph),
    ...udpDnsPolicyWarnings(graph),
    ...dnsCaptureProblems(graph),
  ];
  if (!graph.nodes.length)
    issues.push({ severity: 'warning', message: 'Add an inbound node to start your graph.' });
  const policyReferenced = new Set<string>();
  for (const group of graph.nodes.filter((n) => n.data.kind === 'policy-group')) {
    try {
      for (const { reference } of policyReferenceSet(graph, group))
        if (reference.type === 'node') policyReferenced.add(reference.nodeId);
      const fallback = readPolicySources(group.data).fallback;
      if (group.data.settings.fallbackEnabled && fallback?.type === 'node')
        policyReferenced.add(fallback.nodeId);
    } catch {
      /* Policy diagnostics report malformed source sets. */
    }
  }
  for (const chain of graph.nodes.filter((n) => n.data.kind === 'proxy-chain')) {
    try {
      for (const step of readProxyChain(chain.data).steps)
        if (step.outbound.type === 'node') policyReferenced.add(step.outbound.nodeId);
    } catch {
      /* Chain diagnostics report malformed or missing hops. */
    }
  }
  for (const node of graph.nodes) {
    if (!node.data.label.trim())
      issues.push({ severity: 'error', nodeId: node.id, message: 'Give this node a name.' });
    for (const field of getDefinition(node.data.kind).fields) {
      const problem = fieldProblem(field, node.data.settings);
      if (problem)
        issues.push({
          severity: 'error',
          nodeId: node.id,
          fieldKey: field.key,
          message: `${node.data.label}: ${field.label} — ${problem}`,
        });
    }
    for (const issue of outboundProblems(node.data))
      issues.push({ ...issue, nodeId: node.id, message: `${node.data.label}: ${issue.message}` });
    for (const issue of inboundProblems(node.data))
      issues.push({ ...issue, nodeId: node.id, message: `${node.data.label}: ${issue.message}` });
    for (const issue of ruleTableProblems(node.data))
      issues.push({ ...issue, nodeId: node.id, message: `${node.data.label}: ${issue.message}` });
    for (const issue of policyProblems(node.data))
      issues.push({ ...issue, nodeId: node.id, message: `${node.data.label}: ${issue.message}` });
    for (const issue of fakeDnsNodeProblems(node.data))
      issues.push({ ...issue, nodeId: node.id, message: `${node.data.label}: ${issue.message}` });
    for (const issue of dnsProblems(node.data, { graph, nodeId: node.id }))
      issues.push({ ...issue, nodeId: node.id, message: `${node.data.label}: ${issue.message}` });
    if (
      isNativeDnsHandler(node.data) &&
      graph.nodes.some((other) => other.id !== node.id && isNativeDnsHandler(other.data))
    )
      issues.push({
        severity: 'error',
        nodeId: node.id,
        message: 'Xray has one global DNS module. Keep one native DNS handler per configuration.',
      });
    if (isInboundKind(node.data.kind)) {
      if (
        graph.nodes.some(
          (other) =>
            other.id !== node.id &&
            getDefinition(other.data.kind).category === 'inbound' &&
            other.data.settings.tag === node.data.settings.tag,
        )
      )
        issues.push({
          severity: 'error',
          nodeId: node.id,
          fieldKey: 'tag',
          message: `${node.data.label}: inbound tag ${node.data.settings.tag} is already used.`,
        });
      if (
        graph.nodes.some(
          (other) =>
            other.id !== node.id &&
            isInboundKind(other.data.kind) &&
            inboundEndpoints(node.data).some((e) => inboundEndpoints(other.data).includes(e)),
        )
      )
        issues.push({
          severity: 'error',
          nodeId: node.id,
          fieldKey: 'port',
          message: `${node.data.label}: another inbound uses this listen address and port.`,
        });
    }
    if (isExecutableOutboundKind(node.data.kind)) {
      const tag = node.data.settings.tag;
      if (
        tag &&
        graph.nodes.some(
          (other) =>
            other.id !== node.id &&
            isExecutableOutboundKind(other.data.kind) &&
            other.data.settings.tag === tag,
        )
      )
        issues.push({
          severity: 'error',
          nodeId: node.id,
          fieldKey: 'tag',
          message: `${node.data.label}: outbound tag ${tag} is already used.`,
        });
      const via = String(node.data.settings.dialerProxy ?? '');
      if (via) {
        const visited = new Set<string>([String(tag)]);
        let next = via;
        while (next) {
          if (visited.has(next)) {
            issues.push({
              severity: 'error',
              nodeId: node.id,
              fieldKey: 'dialerProxy',
              message: `${node.data.label}: dial-through settings create a loop.`,
            });
            break;
          }
          visited.add(next);
          const target = graph.nodes.find(
            (other) =>
              isExecutableOutboundKind(other.data.kind) && other.data.settings.tag === next,
          );
          if (!target) {
            issues.push({
              severity: 'warning',
              nodeId: node.id,
              fieldKey: 'dialerProxy',
              message: `${node.data.label}: outbound tag ${next} is not defined in this graph.`,
            });
            break;
          }
          next = String(target.data.settings.dialerProxy ?? '');
        }
      }
    }
    if (
      hasInputPort(node.data.kind) &&
      !policyReferenced.has(node.id) &&
      !(node.data.kind === 'observatory' && node.data.settings.subjects === 'prefixes') &&
      !graph.edges.some((edge) => edge.target === node.id)
    )
      issues.push({
        severity: 'warning',
        nodeId: node.id,
        portId: 'in',
        message: `${node.data.label} has no incoming path.`,
      });
    for (const port of getOutputPorts(node.data.kind, node.data))
      if (
        !(
          port === 'observation' &&
          (node.data.kind !== 'policy-group' || !policyNeedsObservation(node.data))
        ) &&
        !(node.data.kind === 'tun-inbound' && ['dns', 'nat-dns'].includes(port)) &&
        !(node.data.kind === 'dns-routing-filter' && port === 'fakedns') &&
        !graph.edges.some((edge) => edge.source === node.id && edge.sourceHandle === port)
      )
        issues.push({
          severity: 'warning',
          nodeId: node.id,
          portId: port,
          message: `${node.data.label}: the ${portLabel(port, node.data)} path is not connected.`,
        });
  }
  return [...issues, ...policyGraphProblems(graph)];
}

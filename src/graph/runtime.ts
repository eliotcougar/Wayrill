import {
  sharedRuleVariants,
  sharedFilterSources,
  sharedConfigRules,
  icsNodeProblems,
} from './internetSharing';
import { parseJson } from './xrayJson';
import { isGeneratedTag } from './tags';
import { enabledInboundGraph, isDisabledInbound, isGraphInbound } from './inboundState';
import { listenerProblem, listenerEndpointsConflict } from './listeners';
import { resourceCompilationGraph, resourcePlans, type ResourceFilePlan } from './resources';
import {
  captureReachableFilters,
  compileCaptureRouting,
  defaultCaptureOptions,
  type CapturePlan,
} from './capture';
import { routingPaths, RoutingPathError } from './routingPaths';
import { LIMITS, CONFIG_LIMIT_LABEL, OUTBOUND_LIMIT_LABEL } from '../limits';
import {
  compileFakeDnsPools,
  fakeDnsConfigProblems,
  applyAutomaticFakeDnsSettings,
} from './fakeDns';
import { compileXrayGraph } from './xrayCompiler';
import { isProtocolInbound, isProtocolOutbound } from './protocols';
import { compilePolicies } from './policyCompilation';
import { displayNames, type DisplayNames } from './displayNames';
import { getDefinition } from './catalog';
import { isNativeDnsHandler } from './dns';
import { compileDnsGraph } from './dnsCompilation';
import { inboundPreview, isInboundKind, listenerEndpointKeys, inboundPreFilters } from './inbounds';
import { diagnoseGraph, parseGraph, serializeGraph } from './model';
import { xrayOutboundConfig } from './xrayCompiler';
import { expandCompositeOutbounds, compositeDiagnostics } from './composites';
import { compileNatRouting } from './natRouting';
import { isExecutableOutboundKind, outboundBundle } from './outbounds';
import { captureRuleVariants, hasCaptureOnlyApplications, type TableRule } from './rules';
import { effectiveDefaults, factoryDefaults } from './defaults';
import { udpListenerEnvironment } from './udpListeners';
import type { GraphState, RuleNode } from './types';

export interface RuntimeCompilation {
  resources?: ResourceFilePlan[];
  displayNames?: DisplayNames;
  capture?: CapturePlan;
  config: Record<string, unknown>;
  summary: {
    graphName: string;
    listeners: { protocol: string; address: string; port: number }[];
    outboundCount: number;
    trafficRuleCount: number;
    dnsServerCount: number;
  };
  warnings: string[];
}

// Xray evaluates one ordered rule list. Every client path gets an explicit fallback;
// internally generated DNS queries precede client rules and unmatched traffic blocks.
export function compileRuntimeGraph(source: GraphState): RuntimeCompilation {
  const saved = parseGraph(serializeGraph(source));
  const parsed = saved.xray ? saved : enabledInboundGraph(saved);
  return sharingIntent(saved, {
    ...compileResolvedRuntimeGraph(resourceCompilationGraph(parsed)),
    resources: resourcePlans(parsed),
  });
}
function sharingIntent(source: GraphState, compiled: RuntimeCompilation): RuntimeCompilation {
  if (source.nodes.some((n) => n.data.kind === 'ics-tun' && isDisabledInbound(n.data))) {
    compiled.capture = {
      ...defaultCaptureOptions(),
      version: 2,
      inputs: [],
      ...compiled.capture,
      sharingDisabled: true,
    };
  }
  return compiled;
}
export function compileResolvedRuntimeGraph(
  source: GraphState,
  generated = false,
): RuntimeCompilation {
  return sharingIntent(source, compileActiveRuntimeGraph(source, generated));
}
function compileActiveRuntimeGraph(source: GraphState, generated: boolean): RuntimeCompilation {
  const active = enabledInboundGraph(source);
  if (
    !active.nodes.some((n) => isGraphInbound(n.data.kind)) &&
    (!source.xray || source.nodes.some((n) => isGraphInbound(n.data.kind)))
  )
    throw new Error('Enable at least one inbound or local capture source before running.');
  if (source.xray) return compileXrayGraph(source, true, true);
  const sharingErrors = icsNodeProblems(source).filter((i) => i.severity === 'error');
  if (sharingErrors.length) throw new Error(sharingErrors.map((i) => i.message).join('\n'));
  source = active;
  const expansion = expandCompositeOutbounds(source);
  const graph = expansion.graph;
  const unsupported = graph.nodes.find(
    (n) =>
      !isInboundKind(n.data.kind) &&
      !isExecutableOutboundKind(n.data.kind) &&
      ![
        'policy-group',
        'xray-outbound',
        'observatory',
        'routing-filter',
        'dns-routing-filter',
        'dns-servers',
        'fakedns',
      ].includes(n.data.kind) &&
      !isProtocolInbound(n.data.kind) &&
      !isProtocolOutbound(n.data.kind) &&
      !isNativeDnsHandler(n.data),
  );
  if (unsupported)
    throw new Error(
      `${unsupported.data.label}: ${getDefinition(unsupported.data.kind).title} cannot run yet. Use SOCKS/HTTP inbounds, a combined routing filter and configured Xray/DNS destinations.`,
    );
  const diagnostics = compositeDiagnostics(expansion, diagnoseGraph(graph));
  const errors = diagnostics.filter((i) => i.severity === 'error');
  if (errors.length) throw new Error(errors.map((i) => i.message).join('\n'));
  const warnings = diagnostics.filter((i) => i.severity === 'warning').map((i) => i.message);
  const inputs = graph.nodes.filter((n) => isInboundKind(n.data.kind));
  if (!inputs.length || inputs.length > 16)
    throw new Error('A runtime graph needs 1–16 configured Xray inbounds.');
  for (const node of source.nodes) {
    const tag = String(node.data.settings.tag ?? '');
    if (!generated && isGeneratedTag(tag))
      throw new Error(
        `${node.data.label}: this tag prefix is reserved for generated destinations.`,
      );
  }
  const listeners = new Set<string>();
  const inbounds = inputs.map((node) => {
    const inbound = inboundPreview(node.data);
    if (inbound.protocol === 'tun') {
      return inbound;
    }
    if (inbound.listen === 'localhost') inbound.listen = '127.0.0.1';
    const problem = listenerProblem(inbound);
    if (problem) throw new Error(`${node.data.label}: ${problem}`);
    for (const endpoint of listenerEndpointKeys(inbound)) {
      if ([...listeners].some((other) => listenerEndpointsConflict(endpoint, other)))
        throw new Error(`${node.data.label}: another inbound uses this listener.`);
      listeners.add(endpoint);
    }
    return inbound;
  });
  const handlers = graph.nodes.filter((n) => isNativeDnsHandler(n.data));
  if (
    !handlers.length &&
    graph.nodes.some((n) => ['dns-routing-filter', 'dns-servers', 'fakedns'].includes(n.data.kind))
  )
    throw new Error('Connect DNS resolver nodes to a native DNS handler before compiling.');
  const dns = handlers.length
    ? compileDnsGraph(graph, { includePolicies: false, resourcesResolved: true })
    : undefined;
  const outbounds = new Map<string, Record<string, unknown>>();
  outbounds.set('wr-u', {
    tag: 'wr-u',
    protocol: 'blackhole',
    settings: { response: { type: 'none' } },
  });
  for (const node of graph.nodes.filter(
    (n) => isExecutableOutboundKind(n.data.kind) || n.data.kind === 'xray-outbound',
  )) {
    const tag = String(node.data.settings.tag);
    if (handlers.some((h) => h.data.settings.tag === tag))
      throw new Error(
        `${node.data.label}: outbound tags must be unique, including the DNS handler.`,
      );
    for (const outbound of node.data.kind === 'xray-outbound' || node.data.native
      ? [xrayOutboundConfig(node.data)]
      : outboundBundle(node.data))
      outbounds.set(String(outbound.tag), outbound);
    const via = String(node.data.settings.dialerProxy ?? '');
    if (
      via &&
      !graph.nodes.some(
        (n) =>
          (isExecutableOutboundKind(n.data.kind) || n.data.kind === 'xray-outbound') &&
          n.data.settings.tag === via,
      )
    )
      throw new Error(`${node.data.label}: define the dial-through outbound before compiling.`);
  }
  for (const outbound of dns?.outbounds ?? [])
    if (!outbounds.has(String(outbound.tag))) outbounds.set(String(outbound.tag), outbound);
  const policies = compilePolicies(graph, [...outbounds.values()]);
  warnings.push(...policies.warnings);
  for (const outbound of policies.outbounds) outbounds.set(String(outbound.tag), outbound);
  if (outbounds.size > LIMITS.maxOutbounds)
    throw new Error(
      `The service supports at most ${OUTBOUND_LIMIT_LABEL} outbounds, including generated DNS and fallback destinations.`,
    );
  const terminal = (node: RuleNode, allowDns = false): Record<string, string> => {
    if (node.data.kind === 'policy-group') return { balancerTag: String(node.data.settings.tag) };
    if (
      !isExecutableOutboundKind(node.data.kind) &&
      node.data.kind !== 'xray-outbound' &&
      !(allowDns && isNativeDnsHandler(node.data))
    )
      throw new Error(
        `${node.data.label}: connect this path directly to a configured outbound or a policy group${allowDns ? ', or a native DNS handler' : ''}.`,
      );
    return { outboundTag: String(node.data.settings.tag) };
  };
  const rules: Record<string, unknown>[] = [...expansion.rules, ...(dns?.routing.rules ?? [])];
  const paths = routingPaths(graph, rules.length);
  rules.push(...compileNatRouting(graph, paths, terminal, warnings));
  const captureFilters = captureReachableFilters(graph);
  const project = (input: RuleNode, node: RuleNode, row: TableRule) => {
    try {
      if (input.data.kind === 'ics-tun')
        return sharedRuleVariants(row, sharedFilterSources(graph, node.id).host, warnings, node);
      const captured = ['windivert-inbound', 'tun-inbound'].includes(input.data.kind);
      const shared = !captured && captureFilters.has(node.id);
      if (shared && hasCaptureOnlyApplications(row))
        warnings.push(
          `${node.data.label}: ${row.name} — child-process, app and service matching is unavailable for ${input.data.label}; supported conditions and fallback still apply.`,
        );
      return captureRuleVariants(row, captured ? 'capture' : shared ? 'shared' : 'native');
    } catch (error) {
      const issue = new RoutingPathError(
        node.id,
        error instanceof Error ? error.message : String(error),
        'applications',
      );
      Object.assign(issue, { rowId: row.id });
      throw issue;
    }
  };
  // DNS preclassification is global priority, before every input's Data branch.
  for (const input of inputs.filter(
    (n) => !isProtocolInbound(n.data.kind) || n.data.kind === 'tun-inbound',
  )) {
    for (const branch of inboundPreFilters(input.data).filter(
      (b) =>
        b.branch !== 'data' &&
        (input.data.kind !== 'tun-inbound' ||
          graph.edges.some((e) => e.source === input.id && e.sourceHandle === b.branch)),
    )) {
      rules.push(
        ...paths.expand(paths.connected(input, branch.branch), branch.match, {
          terminal: (node) => terminal(node, branch.branch === 'dns'),
          project: (node, row) => project(input, node, row),
        }),
      );
    }
  }
  for (const input of inputs) {
    const scope = { inboundTag: [String(input.data.settings.tag)] };
    const target = paths.connected(input, isProtocolInbound(input.data.kind) ? 'traffic' : 'data');
    rules.push(
      ...paths.expand(target, scope, {
        terminal,
        project: (node, row) => project(input, node, row),
        onRule: (node, row, fields) => {
          if (
            (fields.protocol || fields.attrs) &&
            (!input.data.settings.sniffing || input.data.settings.metadataOnly)
          )
            warnings.push(
              `${input.data.label}: ${node.data.label} / ${row.name} needs payload inspection for protocol/HTTP attributes.`,
            );
        },
      }),
    );
  }
  warnings.push(...paths.warnings);
  const defaultSource = graph.defaults ?? factoryDefaults(),
    defaults = effectiveDefaults(defaultSource);
  const configured = (key: string) => Object.hasOwn(defaultSource.settings, key);
  const config = {
    ...(Object.keys(udpListenerEnvironment(defaultSource)).length
      ? { env: udpListenerEnvironment(defaultSource) }
      : {}),
    log: {
      ...(configured('logLevel') ? { loglevel: defaults.logLevel } : {}),
      ...(configured('dnsLog') ? { dnsLog: defaults.dnsLog } : {}),
      ...(configured('maskAddress') ? { maskAddress: defaults.maskAddress } : {}),
    },
    inbounds,
    outbounds: [...outbounds.values()],
    routing: {
      ...(configured('routingDomainStrategy')
        ? { domainStrategy: defaults.routingDomainStrategy }
        : {}),
      rules,
      ...(policies.balancers.length ? { balancers: policies.balancers } : {}),
    },
    ...policies.observation,
    ...(dns ? { dns: dns.dns } : {}),
    ...(defaults.policy ? { policy: parseJson(String(defaults.policy)) } : {}),
    ...(defaults.statistics ? { stats: {} } : {}),
  };
  if (defaults.metricsEnabled)
    Object.assign(config, {
      metrics: {
        ...(defaults.metricsTag ? { tag: defaults.metricsTag } : {}),
        ...(defaults.metricsListen ? { listen: defaults.metricsListen } : {}),
      },
    });
  const pools = compileFakeDnsPools(graph);
  if (pools !== undefined) Object.assign(config, { fakedns: pools });
  applyAutomaticFakeDnsSettings(graph, config);
  for (const issue of fakeDnsConfigProblems(config)) {
    if (issue.severity === 'error') throw new Error(issue.message);
    warnings.push(issue.message);
  }
  sharedConfigRules(graph, config);
  const capture = compileCaptureRouting(graph, config);
  if (new TextEncoder().encode(JSON.stringify(config)).length > LIMITS.configBytes)
    throw new Error(
      `The compiled configuration exceeds the service limit of ${CONFIG_LIMIT_LABEL}.`,
    );
  return {
    displayNames: displayNames(graph, config, policies.displayNames),
    config,
    capture,
    summary: {
      graphName: graph.name,
      listeners: inbounds
        .filter((i) => i.protocol !== 'tun')
        .map((i) => ({
          protocol: String(i.protocol),
          address: String(i.listen),
          port: Number(i.port),
        })),
      outboundCount: config.outbounds.length,
      trafficRuleCount: (config.routing as { rules: unknown[] }).rules.length,
      dnsServerCount: dns?.dns.servers.length ?? 0,
    },
    warnings: [...new Set(warnings)],
  };
}

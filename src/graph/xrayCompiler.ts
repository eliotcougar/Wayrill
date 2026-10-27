import { sharedConfigRules, icsNodeProblems, sharedRuleVariants } from './internetSharing';
import { compileNatRouting } from './natRouting';
import { listenerProblem, listenerEndpointsConflict } from './listeners';
import { isDisabledInbound } from './inboundState';
import { udpDnsPolicyWarnings } from './dnsTransport';
import { resourceCompilationGraph, resourceDependencies } from './resources';
import { captureRuleVariants, hasCaptureOnlyApplications } from './rules';
import { compileCaptureRouting } from './capture';
import { allOutboundNodes } from './nativePool';
import { routingPaths, RoutingPathError } from './routingPaths';
import { LIMITS, CONFIG_LIMIT_LABEL, OUTBOUND_LIMIT_LABEL } from '../limits';
import {
  compileFakeDnsPools,
  fakeDnsConfigProblems,
  applyAutomaticFakeDnsSettings,
  fakeDnsNodeProblems,
  fakeDnsServers,
} from './fakeDns';
import { structureProblems } from './structure';
import { omitCoreDefaults } from './coreDefaults';
import { getDefinition, getOutputPorts } from './catalog';
import { bindingsFor, defaultsProblems, resolveGraph } from './defaults';
import { inboundPreview, inboundProblems, isInboundKind, listenerEndpointKeys } from './inbounds';
import { projectProxyInbound } from './xrayInbound';
import {
  isProtocolKind,
  loopbackProblems,
  outboundDependencyProblems,
  protocolConfig,
} from './protocols';
import {
  isExecutableOutboundKind,
  outboundBundle,
  outboundPreview,
  outboundProblems,
} from './outbounds';
import { fieldProblem } from './settingValidation';
import { policyProblems, policyNeedsObservation } from './policies';
import { compilePolicies } from './policyCompilation';
import { policyCandidates, readPolicySources, resolvePolicyReference } from './policySources';
import { readRuleTable, ruleTableProblems, projectNativeRule } from './rules';
import {
  isXrayOutbound,
  nativeConfig,
  nativeJson,
  nativeOutputs,
  nativeProblems,
} from './xrayNodes';
import {
  checkJson,
  cloneJson,
  jsonDifferences,
  jsonEqual,
  jsonRecord,
  patchProjection,
  jsonText,
  jsonArray,
  parseJson,
} from './xrayJson';
import { coreProjection, forceProjectionFields } from './xrayProjection';
import type { RuntimeCompilation } from './runtime';
import { displayNames } from './displayNames';
import type { Diagnostic, GraphState, RuleNode, RuleNodeData } from './types';

const lines = (v: unknown) =>
  jsonText(v ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
const extras = (data: RuleNodeData, key: string) =>
  data.settings[key] ? (parseJson(String(data.settings[key])) as Record<string, unknown>) : {};
export function projectBalancer(
  data: RuleNodeData,
  selectors: string[],
  fallback?: string,
): Record<string, unknown> {
  const s = data.settings;
  const settings = {
    ...(s.strategy === 'leastLoad'
      ? {
          expected: s.expected,
          maxRTT: s.maxRTT,
          tolerance: Number(s.tolerance),
          ...(s.baselines ? { baselines: lines(s.baselines) } : {}),
          ...(s.costs ? { costs: parseJson(String(s.costs)) } : {}),
        }
      : {}),
    ...extras(data, 'strategyExtra'),
  };
  return {
    tag: s.tag,
    selector: [...new Set(selectors)],
    strategy: { type: s.strategy, ...(Object.keys(settings).length ? { settings } : {}) },
    ...(fallback ? { fallbackTag: fallback } : {}),
    ...extras(data, 'extra'),
  };
}
export function projectObserver(data: RuleNodeData, subjects: string[]): Record<string, unknown> {
  const s = data.settings;
  return s.mode === 'standard'
    ? {
        subjectSelector: s.subjects === 'prefixes' ? lines(s.selectorPrefixes) : subjects,
        probeURL: s.probeURL,
        probeInterval: s.probeInterval,
        enableConcurrency: s.enableConcurrency,
        ...extras(data, 'extra'),
      }
    : {
        subjectSelector: s.subjects === 'prefixes' ? lines(s.selectorPrefixes) : subjects,
        pingConfig: {
          destination: s.destination,
          ...(s.connectivity ? { connectivity: s.connectivity } : {}),
          interval: s.interval,
          sampling: s.sampling,
          timeout: s.timeout,
          httpMethod: s.httpMethod,
          ...extras(data, 'healthExtra'),
        },
        ...extras(data, 'extra'),
      };
}
export function xrayOutboundConfig(data: RuleNodeData): Record<string, unknown> {
  if (isProtocolKind(data.kind)) return protocolConfig(data);
  if (data.kind === 'xray-outbound') return nativeConfig(data);
  const bundle = outboundBundle(data);
  if (bundle.length !== 1)
    throw new Error(
      `${data.label}: native imports preserve fragment destinations as separate nodes. Use explicit dial-through configuration rather than adding an implicit fragment wrapper.`,
    );
  const current = { ...bundle[0] };
  if (!data.settings.tag) delete current.tag;
  return omitCoreDefaults(data, projectInheritedNode(data, current, outboundPreview));
}
function projectInheritedNode(
  data: RuleNodeData,
  current: Record<string, unknown>,
  preview: (data: RuleNodeData) => Record<string, unknown>,
): Record<string, unknown> {
  if (!data.native) return current;
  let result = patchProjection(data.native.original, data.native.projection, current) as Record<
    string,
    unknown
  >;
  for (const b of bindingsFor(data.kind))
    if (
      data.native.editedKeys?.includes(b.nodeKey) ||
      (data.native.overrideKeys?.includes(b.nodeKey) && !data.overrides?.includes(b.nodeKey))
    ) {
      const f = getDefinition(data.kind).fields.find((f) => f.key === b.nodeKey)!,
        v = data.settings[b.nodeKey];
      const probe =
        f.type === 'json'
          ? JSON.stringify(
              f.jsonShape === 'array'
                ? [{ wayrillProjectionProbe: true }]
                : { wayrillProjectionProbe: true },
            )
          : typeof v === 'boolean'
            ? !v
            : typeof v === 'number'
              ? v + 1
              : `${v}__wayrill_projection_probe__`;
      try {
        result = forceProjectionFields(
          result,
          current,
          jsonDifferences(
            current,
            preview({ ...data, settings: { ...data.settings, [b.nodeKey]: probe } }),
          ),
        );
      } catch {
        throw new Error(
          'Cannot reapply this default to its native fields; edit the native JSON or restore its override.',
        );
      }
    }
  return result;
}
export function xrayInboundConfig(data: RuleNodeData): Record<string, unknown> {
  if (isProtocolKind(data.kind)) return protocolConfig(data);
  if (data.kind === 'xray-inbound') return nativeConfig(data);
  const preview = data.kind === 'proxy-inbound' ? projectProxyInbound : inboundPreview;
  const current = preview(data),
    result = projectInheritedNode(data, current, preview);
  if (
    data.kind === 'proxy-inbound' &&
    data.native &&
    data.native.original.protocol !== data.settings.mode
  ) {
    result.protocol = data.settings.mode;
    // Changing protocol replaces the protocol-specific settings, including
    // fields absent from the import-time projection. Keep other native data.
    result.settings = structuredClone(current.settings);
  }
  return omitCoreDefaults(data, result);
}
export function syncXrayConnections(graph: GraphState): GraphState {
  if (!graph.xray) return graph;
  const servers = new Set(
    graph.nodes.filter((n) => n.data.kind === 'xray-dns-servers').map((n) => n.id),
  );
  const edges = graph.edges.filter((e) => !servers.has(e.source));
  if (
    graph.nodes.some((n) => n.id === graph.xray!.routingNodeId && n.data.kind === 'routing-filter')
  )
    for (const n of graph.nodes.filter((n) => servers.has(n.id)))
      if (nativeOutputs(n.data).length) {
        const old = graph.edges.find(
          (e) =>
            e.source === n.id &&
            e.sourceHandle === 'queries' &&
            e.target === graph.xray!.routingNodeId,
        );
        edges.push({
          ...old,
          id: old?.id ?? crypto.randomUUID(),
          source: n.id,
          sourceHandle: 'queries',
          target: graph.xray.routingNodeId,
          targetHandle: 'in',
          reconnectable: false,
        });
      }
  return { ...graph, edges };
}
import { expandCompositeOutbounds, compositeDiagnostics } from './composites';

export function compileXrayGraph(
  source: GraphState,
  resourcesResolved = false,
  runtimeNat = false,
): RuntimeCompilation {
  const expansion = expandCompositeOutbounds(
    resolveGraph(resourcesResolved ? source : resourceCompilationGraph(source)),
  );
  const graph = expansion.graph,
    meta = graph.xray;
  if (!meta) throw new Error('This graph is not a native Xray import.');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const requireNode = (id: string, kind: string) => {
    const n = byId.get(id);
    if (!n || n.data.kind !== kind)
      throw new Error(`Restore the imported ${kind} node before compiling.`);
    return n;
  };
  const options = requireNode(meta.optionsNodeId, 'xray-options'),
    filter = requireNode(meta.routingNodeId, 'routing-filter');
  if (
    graph.nodes.some(
      (n) =>
        ![
          'xray-inbound',
          'xray-outbound',
          'xray-options',
          'xray-dns',
          'xray-dns-servers',
          'fakedns',
          'routing-filter',
          'policy-group',
          'observatory',
        ].includes(n.data.kind) &&
        !isExecutableOutboundKind(n.data.kind) &&
        !isInboundKind(n.data.kind),
    )
  )
    throw new Error(
      'Native imports support native DNS nodes, a global routing filter with optional child filters, policy groups and executable inputs/outbounds.',
    );
  for (const kind of ['xray-options', 'xray-dns'])
    if (graph.nodes.filter((n) => n.data.kind === kind).length > 1)
      throw new Error(`Imported configs use one shared ${kind} node.`);
  const ordered = (ids: string[], matches: (n: RuleNode) => boolean) => {
    if (ids.some((id) => byId.has(id) && !matches(byId.get(id)!)))
      throw new Error('Native section order refers to a node of the wrong type.');
    const nodes = allOutboundNodes(graph).filter(matches),
      map = new Map(nodes.map((n) => [n.id, n])),
      order = new Set(ids);
    return [
      ...ids.map((id) => map.get(id)).filter((n): n is RuleNode => !!n),
      ...nodes.filter((n) => !order.has(n.id)),
    ];
  };
  const allInputNodes = ordered(
    meta.inboundOrder,
    (n) => n.data.kind === 'xray-inbound' || isInboundKind(n.data.kind),
  );
  const inputNodes = allInputNodes.filter((n) => !isDisabledInbound(n.data));
  const outputNodes = ordered(meta.outboundOrder, isXrayOutbound);
  const groupNodes = ordered(meta.balancerOrder, (n) => n.data.kind === 'policy-group');
  const table = readRuleTable(filter.data.settings);
  const paths = routingPaths(graph),
    target = paths.connected;
  const defaultSeen = new Set<string>();
  const hasDefaultPath =
    outputNodes.length > 0 ||
    graph.edges.some((e) => e.source === filter.id && e.sourceHandle === table.defaultOutput);
  let fallbackNode = hasDefaultPath ? target(filter, table.defaultOutput) : undefined;
  while (fallbackNode?.data.kind === 'routing-filter') {
    if (defaultSeen.has(fallbackNode.id))
      throw new RoutingPathError(
        fallbackNode.id,
        `${fallbackNode.data.label}: default path has a filter cycle.`,
      );
    defaultSeen.add(fallbackNode.id);
    fallbackNode = target(fallbackNode, readRuleTable(fallbackNode.data.settings).defaultOutput);
  }
  for (const node of inputNodes.filter((n) => n.data.kind !== 'ics-tun')) {
    for (const port of getOutputPorts(node.data.kind, node.data)) {
      if (
        ['nat-data', 'nat-dns'].includes(port) ||
        (node.data.kind === 'tun-inbound' &&
          port === 'dns' &&
          !graph.edges.some((edge) => edge.source === node.id && edge.sourceHandle === port))
      )
        continue;
      if (target(node, port).id !== filter.id)
        throw new Error(
          `${node.data.label}: all input paths must lead to the one global routing filter in an imported config.`,
        );
    }
  }
  const inbounds = inputNodes.map((n) => xrayInboundConfig(n.data));
  let outbounds = outputNodes.map((n) => xrayOutboundConfig(n.data));
  if (outbounds.length) {
    const fallback = fallbackNode!;
    if (!isXrayOutbound(fallback) && fallback.data.kind !== 'policy-group')
      throw new Error(
        'Native unmatched traffic follows the first outbound; a policy group needs an explicit catch-all rule.',
      );
    if (fallback.data.kind !== 'policy-group') {
      const index = outputNodes.findIndex((n) => n.id === fallback.id);
      if (index < 0) throw new Error('The native default outbound is missing.');
      outbounds = [outbounds[index], ...outbounds.filter((_, i) => i !== index)];
    }
  }
  const tagSet = new Set<string>();
  for (const o of outbounds) {
    const tag = jsonText(o.tag ?? '');
    if (tag && tagSet.has(tag)) throw new Error('Duplicate native outbound tag.');
    if (tag) tagSet.add(tag);
  }
  const inboundTags = new Set<string>();
  for (const i of inbounds) {
    const tag = jsonText(i.tag ?? '');
    if (tag && inboundTags.has(tag)) throw new Error('Duplicate native inbound tag.');
    if (tag) inboundTags.add(tag);
  }
  const tags = (nodes: RuleNode[]) =>
    new Map(
      nodes
        .filter(
          (n) =>
            n.data.native &&
            typeof n.data.native.original.tag === 'string' &&
            n.data.native.original.tag &&
            n.data.settings.tag,
        )
        .map((n) => [String(n.data.native!.original.tag), String(n.data.settings.tag)]),
    );
  const inboundTagMap = tags(allInputNodes),
    outboundTagMap = tags(outputNodes);
  const outputByTag = new Map(outputNodes.map((n) => [n.data.settings.tag, n]));
  for (const o of outbounds) {
    const node = outputByTag.get(String(o.tag)),
      old = node?.data.native?.original;
    const stream = jsonRecord(o.streamSettings) ? o.streamSettings : undefined,
      sock = stream && jsonRecord(stream.sockopt) ? stream.sockopt : undefined;
    const oldStream = old && jsonRecord(old.streamSettings) ? old.streamSettings : undefined,
      oldSock = oldStream && jsonRecord(oldStream.sockopt) ? oldStream.sockopt : undefined;
    if (
      sock &&
      typeof sock.dialerProxy === 'string' &&
      sock.dialerProxy === oldSock?.dialerProxy &&
      outboundTagMap.has(sock.dialerProxy)
    )
      sock.dialerProxy = outboundTagMap.get(sock.dialerProxy);
    if (
      jsonRecord(o.proxySettings) &&
      old &&
      jsonRecord(old.proxySettings) &&
      o.proxySettings.tag === old.proxySettings.tag &&
      typeof o.proxySettings.tag === 'string' &&
      outboundTagMap.has(o.proxySettings.tag)
    )
      o.proxySettings.tag = outboundTagMap.get(o.proxySettings.tag);
    if (
      o.protocol === 'loopback' &&
      jsonRecord(o.settings) &&
      old &&
      jsonRecord(old.settings) &&
      o.settings.inboundTag === old.settings.inboundTag &&
      typeof o.settings.inboundTag === 'string' &&
      inboundTagMap.has(o.settings.inboundTag)
    )
      o.settings.inboundTag = inboundTagMap.get(o.settings.inboundTag);
  }
  const applicationWarnings: string[] = [];
  const captureAvailable = inputNodes.some((n) =>
    ['windivert-inbound', 'tun-inbound'].includes(n.data.kind),
  );
  const ordinaryAvailable = inputNodes.some(
    (n) => !['windivert-inbound', 'tun-inbound'].includes(n.data.kind),
  );
  const rules = paths.expand(
    filter,
    {},
    {
      defaultType: false,
      rootFallback: hasDefaultPath,
      implicitFallbackId: fallbackNode?.data.kind === 'policy-group' ? undefined : fallbackNode?.id,
      terminal: (destination) => {
        if (!isXrayOutbound(destination) && destination.data.kind !== 'policy-group')
          throw new RoutingPathError(
            destination.id,
            `${destination.data.label}: routing outputs must lead to an outbound, policy group or child filter.`,
          );
        const tag = String(destination.data.settings.tag ?? '');
        if (!tag) throw new Error('An explicit routing rule needs a tagged destination.');
        return { [destination.data.kind === 'policy-group' ? 'balancerTag' : 'outboundTag']: tag };
      },
      project: (_node, row) => {
        if (captureAvailable && ordinaryAvailable && hasCaptureOnlyApplications(row))
          applicationWarnings.push(
            `${_node.data.label}: ${row.name} — child-process, app and service matching applies only to local capture; proxy requests use supported conditions and fallback.`,
          );
        return captureRuleVariants(row, captureAvailable ? 'shared' : 'native').map((projected) => {
          const raw = projectNativeRule(row, projected);
          if (
            jsonArray(raw.inboundTag) &&
            row.native &&
            jsonEqual(projected.inboundTag, row.native.projection.inboundTag)
          )
            raw.inboundTag = raw.inboundTag.map((tag) =>
              typeof tag === 'string' ? (inboundTagMap.get(tag) ?? tag) : tag,
            );
          return raw;
        });
      },
    },
  );
  if (runtimeNat)
    rules.unshift(
      ...compileNatRouting(
        graph,
        paths,
        (destination) => {
          if (!isXrayOutbound(destination) && destination.data.kind !== 'policy-group')
            throw new RoutingPathError(
              destination.id,
              `${destination.data.label}: NAT paths must lead to an outbound, policy group or traffic filter.`,
            );
          const tag = String(destination.data.settings.tag ?? '');
          if (!tag) throw new Error('A NAT routing destination needs a tag.');
          return {
            [destination.data.kind === 'policy-group' ? 'balancerTag' : 'outboundTag']: tag,
          };
        },
        applicationWarnings,
      ),
    );
  for (const input of inputNodes.filter((n) => n.data.kind === 'ics-tun')) {
    const start = target(input, 'traffic');
    const extra = paths.expand(
      start,
      { inboundTag: [String(input.data.settings.tag)] },
      {
        terminal: (destination) => ({
          [destination.data.kind === 'policy-group' ? 'balancerTag' : 'outboundTag']: String(
            destination.data.settings.tag,
          ),
        }),
        project: (node, row) =>
          sharedRuleVariants(
            row,
            inputNodes.some((n) => n.data.kind !== 'ics-tun'),
            applicationWarnings,
            node,
          ).map((variant) => {
            const fields = projectNativeRule(row, variant);
            // This is a derived copy; retain the native ruleTag on the host rule.
            delete fields.ruleTag;
            return fields;
          }),
      },
    );
    rules.unshift(...extra);
  }
  const ruleTags = new Set<unknown>();
  for (const rule of rules)
    if (rule.ruleTag) {
      if (ruleTags.has(rule.ruleTag))
        throw new Error(
          'A shared branch would duplicate a native ruleTag. Use distinct tagged rules on separate branches.',
        );
      ruleTags.add(rule.ruleTag);
    }
  const observer = graph.nodes.find((n) => n.data.kind === 'observatory');
  let policyNames: Record<string, string> = {};
  const observation: Record<string, unknown> = {};
  let balancers: Record<string, unknown>[],
    aliases: Record<string, unknown>[] = [];
  if (
    groupNodes.some((n) => n.data.settings.selection !== 'prefixes' || !n.data.native) ||
    (observer &&
      (graph.nodes.filter((n) => n.data.kind === 'observatory').length > 1 ||
        observer.data.settings.subjects === 'groups' ||
        graph.edges.some((e) => e.sourceHandle === 'observation')))
  ) {
    const policy = compilePolicies(graph, outbounds);
    aliases = policy.outbounds;
    policyNames = policy.displayNames;
    balancers = groupNodes.map((n) => {
      const projection = policy.balancers.find((b) => b.tag === n.data.settings.tag)!;
      return n.data.native
        ? (patchProjection(n.data.native.original, n.data.native.projection, projection) as Record<
            string,
            unknown
          >)
        : projection;
    });
    for (const [key, projected] of Object.entries(policy.observation)) {
      const original = graph.nodes.find(
        (n) =>
          n.data.kind === 'observatory' &&
          n.data.native &&
          (n.data.settings.mode === 'burst' ? 'burstObservatory' : 'observatory') === key,
      );
      observation[key] = original?.data.native
        ? patchProjection(original.data.native.original, original.data.native.projection, projected)
        : projected;
    }
  } else {
    balancers = groupNodes.map((n) => {
      const selectors = lines(n.data.settings.selectorPrefixes),
        members = policyCandidates(graph, n).map((c) => c.node);
      const memberIds = new Set(members.map((m) => m.id));
      const actual = outputNodes.filter((o) =>
        selectors.some((p) => String(o.data.settings.tag ?? '').startsWith(p)),
      );
      if (actual.length !== members.length || actual.some((o) => !memberIds.has(o.id)))
        throw new Error(`${n.data.label}: native prefix membership and drawn connections differ.`);
      const ref = readPolicySources(n.data).fallback;
      const fallback =
        n.data.settings.fallbackEnabled && ref ? resolvePolicyReference(graph, ref) : undefined;
      if (n.data.settings.fallbackEnabled && !fallback)
        throw new Error(`${n.data.label}: choose a fallback outbound.`);
      if (fallback && !isXrayOutbound(fallback))
        throw new Error('Policy fallback must be an outbound.');
      const projected = projectBalancer(
        n.data,
        selectors,
        fallback ? String(fallback.data.settings.tag) : undefined,
      );
      return n.data.native
        ? (patchProjection(n.data.native.original, n.data.native.projection, projected) as Record<
            string,
            unknown
          >)
        : projected;
    });
    if (observer) {
      const key = observer.data.settings.mode === 'burst' ? 'burstObservatory' : 'observatory',
        projected = projectObserver(observer.data, []);
      observation[key] = observer.data.native
        ? patchProjection(observer.data.native.original, observer.data.native.projection, projected)
        : projected;
    }
  }
  const config = patchProjection(
    nativeJson(options.data),
    meta.defaultsProjection,
    coreProjection(graph.defaults!),
  ) as Record<string, unknown>;
  if (meta.inboundsPresent || inbounds.length) config.inbounds = inbounds;
  if (meta.outboundsPresent || outbounds.length || aliases.length)
    config.outbounds = [...outbounds, ...aliases];
  const routing = jsonRecord(config.routing) ? config.routing : {};
  if (meta.rulesPresent || rules.length) routing.rules = rules;
  if (meta.balancersPresent || balancers.length) routing.balancers = balancers;
  if (meta.routingPresent || Object.keys(routing).length) config.routing = routing;
  Object.assign(config, observation);
  let dnsServers = 0;
  if (meta.dnsNodeId) {
    const dns = requireNode(meta.dnsNodeId, 'xray-dns');
    const options = nativeJson(dns.data);
    if (Object.hasOwn(options, 'servers'))
      throw new Error('Keep DNS servers in their ordered connected nodes.');
    const servers = nativeOutputs(dns.data).flatMap((port) => {
      const node = target(dns, port.id);
      if (node.data.kind === 'fakedns') return cloneJson(fakeDnsServers(node.data));
      if (node.data.kind !== 'xray-dns-servers')
        throw new Error('Connect native DNS outputs to native server nodes.');
      const raw = nativeJson(node.data);
      if (!jsonArray(raw.servers)) throw new Error('Use a servers array.');
      return cloneJson(raw.servers);
    });
    dnsServers = servers.length;
    config.dns = { ...options, ...(meta.dnsServersPresent || servers.length ? { servers } : {}) };
  } else if (
    graph.nodes.some((n) => n.data.kind === 'xray-dns' || n.data.kind === 'xray-dns-servers')
  )
    throw new Error('An added native DNS branch needs an imported global DNS reference.');
  const pools = compileFakeDnsPools(graph);
  if (graph.nodes.some((n) => n.data.kind === 'fakedns') && config.fakedns !== undefined)
    throw new Error(
      'Keep shared FakeDNS pools in the FakeDNS nodes, rather than duplicating them in core options.',
    );
  if (pools !== undefined) config.fakedns = pools;
  applyAutomaticFakeDnsSettings(graph, config);
  const fakeIssues = fakeDnsConfigProblems(config);
  const fakeError = fakeIssues.find((i) => i.severity === 'error');
  if (fakeError) throw new Error(fakeError.message);
  if (expansion.rules.length) {
    const routing = config.routing as Record<string, unknown>;
    routing.rules = [...expansion.rules, ...((routing.rules as Record<string, unknown>[]) ?? [])];
  }
  sharedConfigRules(graph, config);
  const capture = compileCaptureRouting(graph, config);
  checkJson(config);
  if (new TextEncoder().encode(JSON.stringify(config)).length > LIMITS.configBytes)
    throw new Error(`The exported configuration exceeds ${CONFIG_LIMIT_LABEL}.`);
  if (outbounds.length + aliases.length > LIMITS.maxOutbounds)
    throw new Error(`The service supports at most ${OUTBOUND_LIMIT_LABEL} outbounds.`);
  return {
    displayNames: {
      ...displayNames(graph, config, policyNames),
      ...(paths.defaultTrace?.length ? { routingDefault: paths.defaultTrace } : {}),
    },
    config,
    capture,
    summary: {
      graphName: graph.name,
      listeners: inbounds
        .filter((i) => i.protocol !== 'tun')
        .map((i) => ({
          protocol: jsonText(i.protocol ?? ''),
          address: jsonText(i.listen ?? ''),
          port: Number(i.port ?? 0),
        })),
      outboundCount: (config.outbounds as unknown[] | undefined)?.length ?? 0,
      trafficRuleCount: (config.routing as { rules?: unknown[] } | undefined)?.rules?.length ?? 0,
      dnsServerCount: dnsServers,
    },
    warnings: [
      ...new Set(applicationWarnings),
      ...paths.warnings,
      ...fakeIssues.filter((i) => i.severity === 'warning').map((i) => i.message),
      ...requiredXrayAssets(config).map(
        (a) => `Xray needs the matching ${a} asset for this configuration.`,
      ),
    ],
  };
}
export function requiredXrayAssets(config: Record<string, unknown>): string[] {
  return resourceDependencies(config);
}
export function diagnoseXrayGraph(graph: GraphState): Diagnostic[] {
  try {
    const expansion = expandCompositeOutbounds(resolveGraph(graph));
    if (expansion.changed)
      return compositeDiagnostics(expansion, diagnoseXrayGraph(expansion.graph));
  } catch (error) {
    const p = error as Error & { nodeId?: string; fieldKey?: string };
    return [{ severity: 'error', message: p.message, nodeId: p.nodeId, fieldKey: p.fieldKey }];
  }
  const issues: Diagnostic[] = [
    ...structureProblems(graph),
    ...icsNodeProblems(graph),
    ...udpDnsPolicyWarnings(graph),
    ...(graph.defaults
      ? defaultsProblems(graph.defaults).map((issue) => ({ ...issue, scope: 'defaults' as const }))
      : []),
  ];
  const add = (
    n: RuleNode | undefined,
    message: string,
    severity: Diagnostic['severity'] = 'error',
    fieldKey?: string,
    location: Partial<Diagnostic> = {},
  ) =>
    issues.push({
      ...location,
      nodeId: n?.id,
      fieldKey,
      severity,
      message: n ? `${n.data.label}: ${message}` : message,
    });
  for (const n of graph.nodes) {
    if (isDisabledInbound(n.data)) continue;
    for (const f of getDefinition(n.data.kind).fields) {
      const p = fieldProblem(f, n.data.settings);
      if (p) add(n, `${f.label} — ${p}`, 'error', f.key);
    }
    for (const p of [
      ...nativeProblems(n.data),
      ...fakeDnsNodeProblems(n.data),
      ...outboundProblems(n.data),
      ...inboundProblems(n.data),
      ...ruleTableProblems(n.data),
    ])
      add(n, p.message, p.severity, p.fieldKey, p);
    if (n.data.kind === 'policy-group' || n.data.kind === 'observatory') {
      // Unedited omitted native defaults do not need to pass a more restrictive
      // visual-editor schema. Changed settings receive the normal editor checks.
      try {
        const p =
          n.data.kind === 'observatory'
            ? projectObserver(n.data, [])
            : projectBalancer(
                n.data,
                lines(n.data.settings.selectorPrefixes),
                n.data.settings.fallbackEnabled
                  ? String(
                      resolvePolicyReference(graph, readPolicySources(n.data).fallback!)?.data
                        .settings.tag ?? '',
                    )
                  : undefined,
              );
        if (!n.data.native || !jsonEqual(p, n.data.native.projection))
          for (const issue of policyProblems(n.data))
            add(n, issue.message, issue.severity, issue.fieldKey, issue);
      } catch (e) {
        add(n, e instanceof Error ? e.message : 'Invalid policy settings.');
      }
    }
  }
  for (const n of graph.nodes) {
    if (isDisabledInbound(n.data)) continue;
    let required: string[] = [];
    if (
      n.data.kind === 'xray-inbound' ||
      isInboundKind(n.data.kind) ||
      n.data.kind === 'policy-group' ||
      n.data.kind === 'xray-dns' ||
      n.data.kind === 'xray-dns-servers'
    )
      required =
        n.data.kind === 'policy-group' && !policyNeedsObservation(n.data)
          ? []
          : getOutputPorts(n.data.kind, n.data).filter(
              (port) => n.data.kind !== 'tun-inbound' || !['dns', 'nat-dns'].includes(port),
            );
    if (n.data.kind === 'routing-filter')
      try {
        const table = readRuleTable(n.data.settings);
        required = [
          ...new Set([
            ...table.rules.filter((r) => r.enabled).map((r) => r.output),
            ...(table.tunAmbiguity?.action === 'allow' && table.tunAmbiguity.output
              ? [table.tunAmbiguity.output]
              : []),
            ...(graph.nodes.some(isXrayOutbound) ? [table.defaultOutput] : []),
          ]),
        ];
      } catch {
        /* Table diagnostics already describe the draft. */
      }
    for (const port of required)
      if (!graph.edges.some((e) => e.source === n.id && e.sourceHandle === port))
        add(
          n,
          `Connect the ${nativeOutputs(n.data).find((p) => p.id === port)?.name ?? port} output before compiling.`,
          'error',
          undefined,
          { portId: port },
        );
    if (
      n.data.kind === 'xray-dns-servers' &&
      !graph.edges.some(
        (e) =>
          e.target === n.id && graph.nodes.find((s) => s.id === e.source)?.data.kind === 'xray-dns',
      )
    )
      add(
        n,
        'This resolver is not connected to the global DNS server list and will not be exported.',
        'warning',
      );
  }
  const sockets = new Map<string, RuleNode>(),
    inputTags = new Map<string, RuleNode>();
  for (const node of graph.nodes.filter(
    (n) =>
      !isDisabledInbound(n.data) && (n.data.kind === 'xray-inbound' || isInboundKind(n.data.kind)),
  )) {
    try {
      const inbound = xrayInboundConfig(node.data),
        tag = jsonText(inbound.tag ?? '');
      if (tag && inputTags.has(tag)) {
        add(node, 'Another inbound uses this inbound tag.', 'error', 'tag');
        add(inputTags.get(tag), 'Another inbound uses this inbound tag.', 'error', 'tag');
      }
      if (tag) inputTags.set(tag, node);
      for (const socket of listenerEndpointKeys(inbound)) {
        const previous = [...sockets].find(([other]) =>
          listenerEndpointsConflict(socket, other),
        )?.[1];
        if (previous) {
          add(
            node,
            `Listener conflicts with ${previous.data.label} on ${socket}.`,
            'error',
            'port',
          );
          add(
            previous,
            `Listener conflicts with ${node.data.label} on ${socket}.`,
            'error',
            'port',
          );
        } else sockets.set(socket, node);
      }
    } catch {
      /* Field diagnostics already describe invalid input drafts. */
    }
  }
  try {
    const compiled = compileXrayGraph(graph);
    for (const warning of compiled.warnings) add(undefined, warning, 'warning');
    for (const issue of outboundDependencyProblems(compiled.config))
      add(
        graph.nodes.find((n) => isXrayOutbound(n) && n.data.settings.tag === issue.tag),
        issue.message,
        'error',
        'dialerProxy',
      );
    for (const issue of loopbackProblems(compiled.config))
      add(
        graph.nodes.find((n) => n.data.settings.tag === issue.tag && isXrayOutbound(n)),
        issue.message,
        issue.severity,
        'json',
      );
    for (const node of graph.nodes.filter(
      (n) =>
        !isDisabledInbound(n.data) &&
        (n.data.kind === 'xray-inbound' || isInboundKind(n.data.kind)),
    )) {
      const problem = listenerProblem(xrayInboundConfig(node.data));
      if (problem)
        add(node, problem, 'warning', problem.startsWith('Listen port') ? 'port' : 'listen');
    }
    if (
      jsonRecord(compiled.config.metrics) &&
      typeof compiled.config.metrics.listen === 'string' &&
      compiled.config.metrics.listen
    ) {
      const endpoint = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(compiled.config.metrics.listen);
      if (
        !endpoint ||
        !['127.0.0.1', '::1'].includes(endpoint[1] ?? endpoint[2]) ||
        Number(endpoint[3]) < 1024 ||
        Number(endpoint[3]) > 65535 ||
        listenerEndpointKeys({
          protocol: 'http',
          listen: endpoint[1] ?? endpoint[2],
          port: Number(endpoint[3]),
        }).some((key) => [...sockets.keys()].some((other) => listenerEndpointsConflict(key, other)))
      )
        add(
          graph.nodes.find((n) => n.id === graph.xray?.optionsNodeId),
          'Metrics can be exported, but the service requires an unused loopback port of at least 1024.',
          'warning',
          'json',
        );
    }
    const unsupported = Object.keys(compiled.config).filter(
      (k) =>
        ![
          'log',
          'inbounds',
          'outbounds',
          'routing',
          'dns',
          'policy',
          'stats',
          'fakedns',
          'observatory',
          'burstObservatory',
          'metrics',
        ].includes(k),
    );
    if (unsupported.length)
      add(
        undefined,
        `Preserved sections ${unsupported.join(', ')} can be exported; the current service cannot run them.`,
        'warning',
      );
  } catch (e) {
    add(undefined, e instanceof Error ? e.message : String(e));
  }
  return issues;
}

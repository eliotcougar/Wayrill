import { makeNode, getDefinition, validateSettings } from './catalog';
import { resolveNodeData, bindingsFor } from './defaults';
import { allOutboundNodes } from './nativePool';
import {
  isOutboundKind,
  isExecutableOutboundKind,
  outboundBundle,
  outboundPreview,
} from './outbounds';
import { xrayOutboundConfig } from './xrayCompiler';
import { xrayOutbound, type Profile, type StashEntry } from '../profiles/import';
import {
  readPolicySources,
  policyProfileId,
  policyRuntimeId,
  policyReferenceSet,
  resolvePolicyReference,
  type PolicyReference,
  type PolicyProfile,
  type PolicySources,
} from './policySources';
import { policyNeedsObservation } from './policies';
import { fragmentFields } from './trafficTuning';
import {
  jsonEqual,
  jsonRecord,
  checkJson,
  jsonText,
  jsonArray,
  parseJson,
  parseJsonObject,
} from './xrayJson';
import { fieldProblem } from './settingValidation';
import { outboundProblems } from './outbounds';
import { LIMITS } from '../limits';
import type { GraphState, RuleNode, RuleNodeData, Diagnostic } from './types';

export {
  readProxyChain,
  emptyProxyChain,
  isCompositeKind,
  chainProblems,
  proxyChainDefinition,
} from './proxyChains';
import { readProxyChain, isCompositeKind } from './proxyChains';
export function profileNode(
  profile: Profile,
  name: string,
  graph: GraphState,
  id: string,
): RuleNode {
  const node = makeNode(profile.kind, { x: 0, y: 0 }, id);
  node.data.label = name;
  node.data.settings = validateSettings(profile.kind, {
    ...node.data.settings,
    ...profile.settings,
  });
  node.data.overrides = bindingsFor(profile.kind)
    .filter((b) => Object.hasOwn(profile.settings, b.nodeKey))
    .map((b) => b.nodeKey);
  node.data = resolveNodeData(node.data, graph.defaults);
  return node;
}
export function observationSnapshot(data: RuleNodeData): RuleNodeData['settings'] | undefined {
  if (!data.settings.observationSettings) return undefined;
  const value: unknown = parseJson(String(data.settings.observationSettings));
  checkJson(value);
  if (
    !jsonRecord(value) ||
    !Object.values(value).every(
      (v) =>
        typeof v === 'string' ||
        typeof v === 'boolean' ||
        (typeof v === 'number' && Number.isFinite(v)),
    )
  )
    throw new Error('Invalid saved observation settings.');
  return validateSettings('observatory', { ...getDefinition('observatory').defaults, ...value });
}
/** Observation is a property of the entire prepared definition, including nested choices. */
export function outboundNeedsObservation(
  graph: GraphState,
  node: RuleNode,
  seen = new Set<string>(),
): boolean {
  if (!isCompositeKind(node.data.kind) || seen.has(node.id) || seen.size >= 16) return false;
  if (policyNeedsObservation(node.data)) return true;
  const next = new Set(seen);
  next.add(node.id);
  const refs =
    node.data.kind === 'proxy-chain'
      ? readProxyChain(node.data).steps.map((s) => s.outbound)
      : [
          ...policyReferenceSet(graph, node).map((r) => r.reference),
          ...(node.data.settings.fallbackEnabled && readPolicySources(node.data).fallback
            ? [readPolicySources(node.data).fallback!]
            : []),
        ];
  return refs.some((ref) =>
    outboundNeedsObservation(graph, resolvePolicyReference(graph, ref), next),
  );
}
/** Import collisions must not make a copied policy follow an unrelated existing subscription. */
export function remapPreparedSubscriptions(
  profile: Profile,
  groupIds: Map<string, string>,
  depth = 0,
): Profile {
  if (!isCompositeKind(profile.kind)) return profile;
  if (depth >= 16) throw new Error('Prepared outbounds exceed 16 nested levels.');
  const settings = { ...profile.settings };
  const node = makeNode(profile.kind, { x: 0, y: 0 });
  node.data.settings = { ...node.data.settings, ...settings };
  const reference = (ref: PolicyReference): PolicyReference => {
    if (ref.type === 'node') return ref;
    const next = remapPreparedSubscriptions(ref.profile, groupIds, depth + 1);
    return {
      ...ref,
      profile: next,
      id: policyProfileId(next),
      ...(ref.source
        ? {
            source: {
              ...ref.source,
              groupId: groupIds.get(ref.source.groupId) ?? ref.source.groupId,
            },
          }
        : {}),
    };
  };
  if (profile.kind === 'policy-group') {
    const sources = readPolicySources(node.data);
    settings.sources = JSON.stringify({
      ...sources,
      manual: sources.manual.map(reference),
      subscriptions: sources.subscriptions.map((s) => ({
        ...s,
        groupId: groupIds.get(s.groupId) ?? s.groupId,
        entries: s.entries.map((r) => reference(r) as PolicyProfile),
      })),
      ...(sources.fallback ? { fallback: reference(sources.fallback) } : {}),
    });
  } else {
    const chain = readProxyChain(node.data);
    settings.steps = JSON.stringify({
      ...chain,
      steps: chain.steps.map((s) => ({ ...s, outbound: reference(s.outbound) })),
    });
  }
  return { ...profile, settings };
}
export function copyOutboundReference(
  graph: GraphState,
  reference: PolicyReference,
  seen = new Set<string>(),
): PolicyProfile {
  if (reference.type === 'profile') {
    if (!isCompositeKind(reference.profile.kind)) return structuredClone(reference);
    const synthetic = profileNode(
      reference.profile,
      reference.name,
      graph,
      'copy-' + policyRuntimeId(reference),
    );
    if (reference.source) synthetic.data.stashLink = reference.source;
    return copyOutboundReference(
      { ...graph, nodes: [...graph.nodes, synthetic] },
      { type: 'node', nodeId: synthetic.id },
      seen,
    );
  }
  if (seen.has(reference.nodeId) || seen.size >= 16)
    throw new Error('Outbound definitions contain a cycle or exceed 16 nested levels.');
  const node = allOutboundNodes(graph).find((n) => n.id === reference.nodeId);
  if (!node || !isOutboundKind(node.data.kind))
    throw new Error('A referenced outbound no longer exists.');
  const next = new Set(seen);
  next.add(node.id);
  let profile: Profile;
  if (isCompositeKind(node.data.kind)) {
    const settings = structuredClone(node.data.settings);
    settings.observe = outboundNeedsObservation(graph, node);
    if (node.data.kind === 'policy-group') {
      const sources = structuredClone(readPolicySources(node.data));
      if (settings.selection === 'prefixes') {
        sources.manual = policyReferenceSet(graph, node).map((r) => r.reference);
        sources.subscriptions = [];
        settings.selection = 'manual';
      }
      sources.manual = sources.manual.map((r) => copyOutboundReference(graph, r, next));
      if (sources.fallback) sources.fallback = copyOutboundReference(graph, sources.fallback, next);
      settings.sources = JSON.stringify(sources);
    } else {
      const chain = readProxyChain(node.data);
      settings.steps = JSON.stringify({
        ...chain,
        steps: chain.steps.map((s) => ({
          ...s,
          outbound: copyOutboundReference(graph, s.outbound, next),
        })),
      });
    }
    const edge = graph.edges.find((e) => e.source === node.id && e.sourceHandle === 'observation');
    const observer =
      edge && graph.nodes.find((n) => n.id === edge.target && n.data.kind === 'observatory');
    if (observer) settings.observationSettings = JSON.stringify(observer.data.settings);
    profile = { kind: node.data.kind, settings };
  } else {
    if (node.data.kind === 'vless-outbound' && node.data.settings.finalFragmentEnabled) {
      const data = resolveNodeData(node.data, graph.defaults);
      profile = xrayOutbound(outboundPreview(data));
      for (const field of fragmentFields) profile.settings[field.key] = data.settings[field.key];
    } else profile = xrayOutbound(xrayOutboundConfig(node.data));
  }
  return {
    type: 'profile',
    id: policyProfileId(profile),
    name: node.data.label,
    profile,
    ...(node.data.stashLink ? { source: { ...node.data.stashLink } } : {}),
  };
}
export function preparedEntry(
  graph: GraphState,
  nodeId: string,
  id: string = crypto.randomUUID(),
): StashEntry {
  const copy = copyOutboundReference(graph, { type: 'node', nodeId });
  validatePreparedProfile(copy.profile);
  return {
    id,
    name: copy.name,
    protocol: copy.profile.kind,
    address: '',
    raw: '',
    problem: '',
    profile: copy.profile,
  };
}
export function validatePreparedProfile(profile: Profile, depth = 0): void {
  if (depth >= 16) throw new Error('Prepared outbounds exceed 16 nested levels.');
  if (!isCompositeKind(profile.kind)) {
    const definition = getDefinition(profile.kind);
    if (!definition) throw new Error('Unknown prepared outbound protocol.');
    const settings = validateSettings(profile.kind, {
      ...definition.defaults,
      ...profile.settings,
    });
    const issue = [
      ...definition.fields.map((f) => fieldProblem(f, settings)),
      ...outboundProblems({ kind: profile.kind, settings, label: '', description: '' })
        .filter((p) => p.severity === 'error')
        .map((p) => p.message),
    ].find(Boolean);
    if (issue) throw new Error(String(issue));
    return;
  }
  const node = makeNode(profile.kind, { x: 0, y: 0 });
  node.data.settings = { ...node.data.settings, ...profile.settings };
  observationSnapshot(node.data);
  const refs =
    profile.kind === 'proxy-chain'
      ? readProxyChain(node.data).steps.map((s) => s.outbound)
      : (() => {
          const sources = readPolicySources(node.data);
          if (profile.settings.selection === 'prefixes')
            throw new Error(
              'Save policy groups as a manual or subscription set, rather than graph tag prefixes.',
            );
          return [
            ...sources.manual,
            ...sources.subscriptions.flatMap((s) => s.entries),
            ...(sources.fallback ? [sources.fallback] : []),
          ];
        })();
  if (profile.kind === 'proxy-chain' && refs.length < 2)
    throw new Error('A saved chain needs at least two hops.');
  for (const ref of refs) {
    if (ref.type !== 'profile')
      throw new Error('Saved prepared outbounds must contain independent copies.');
    if (policyProfileId(ref.profile) !== ref.id)
      throw new Error('Invalid prepared outbound identity.');
    validatePreparedProfile(ref.profile, depth + 1);
  }
}

export interface CompositeExpansion {
  graph: GraphState;
  rules: Record<string, unknown>[];
  origins: Map<string, string>;
  references: Set<string>;
  changed: boolean;
}
/** Internal relay nodes have no canvas wires. Report real problems on their owning card. */
export function compositeDiagnostics(
  expansion: CompositeExpansion,
  issues: Diagnostic[],
): Diagnostic[] {
  return issues
    .filter(
      (issue) =>
        !(
          issue.severity === 'warning' &&
          issue.nodeId &&
          (expansion.origins.has(issue.nodeId) || expansion.references.has(issue.nodeId)) &&
          (issue.message.endsWith('has no incoming path.') ||
            issue.message.includes('unreachable from any runtime inbound'))
        ),
    )
    .map((issue) => ({
      ...issue,
      nodeId: issue.nodeId ? (expansion.origins.get(issue.nodeId) ?? issue.nodeId) : undefined,
    }));
}
export function expandCompositeOutbounds(source: GraphState): CompositeExpansion {
  const original = allOutboundNodes(source);
  const byId = new Map(original.map((n) => [n.id, n]));
  const nodes = [...source.nodes],
    edges = [...source.edges];
  const rules: Record<string, unknown>[] = [],
    origins = new Map<string, string>();
  const tags = new Set(original.map((n) => String(n.data.settings.tag ?? '')));
  const built = new Map<string, RuleNode>();
  const references = new Set<string>();
  let serial = 0,
    changed = false;
  const allocate = (origin: string) => {
    if (++serial > LIMITS.maxOutbounds)
      throw new Error('Prepared outbounds exceed the executable outbound budget.');
    const id = 'prepared-' + serial + '-' + origin.slice(0, 90);
    let tag = 'wayrill-chain-' + serial + '-' + origin.slice(0, 90);
    while (tags.has(tag)) tag += '-x';
    tags.add(tag);
    origins.set(id, origin);
    return { id, tag };
  };
  const materialize = (config: Record<string, unknown>, id: string, label: string): RuleNode => {
    const { tag, ...options } = config;
    const node = makeNode('xray-outbound', { x: 0, y: 0 }, id);
    node.data.label = label;
    node.data.settings = { tag: String(tag), json: JSON.stringify(options) };
    return node;
  };
  const connectObservation = (group: RuleNode, owner: RuleNode) => {
    if (!policyNeedsObservation(group.data)) return;
    const edge = source.edges.find(
      (e) => e.source === owner.id && e.sourceHandle === 'observation',
    );
    const observer = edge
      ? source.nodes.find((n) => n.id === edge.target && n.data.kind === 'observatory')
      : undefined;
    if (!observer)
      throw new Error(
        owner.data.label + ': connect its Observation port to the shared observatory.',
      );
    if (!edges.some((e) => e.source === group.id && e.sourceHandle === 'observation'))
      edges.push({
        id: 'prepared-observation-' + group.id,
        source: group.id,
        sourceHandle: 'observation',
        target: observer.id,
        targetHandle: 'in',
      });
  };
  const nodeFor = (ref: PolicyReference, owner: RuleNode): RuleNode => {
    if (ref.type === 'node') {
      references.add(ref.nodeId);
      const node = byId.get(ref.nodeId);
      if (!node || !isOutboundKind(node.data.kind))
        throw new Error(owner.data.label + ': a referenced outbound is missing.');
      return node;
    }
    if (policyProfileId(ref.profile) !== ref.id)
      throw new Error('A prepared outbound has an inconsistent configuration identity.');
    return profileNode(ref.profile, ref.name, source, 'copy-' + policyRuntimeId(ref));
  };
  const emit = (
    node: RuleNode,
    owner: RuleNode,
    underlay: string | undefined,
    path: Set<string>,
    publicRoot = false,
  ): RuleNode => {
    if (path.has(node.id) || path.size >= 16)
      throw new Error(
        owner.data.label + ': outbound definitions contain a cycle or exceed 16 nested levels.',
      );
    const next = new Set(path);
    next.add(node.id);
    const key =
      owner.id + ':' + node.id + ':' + (underlay ?? '') + ':' + (publicRoot ? 'root' : 'copy');
    const cached = built.get(key);
    if (cached) return cached;
    const allocated = publicRoot
      ? { id: node.id, tag: String(node.data.settings.tag) }
      : allocate(owner.id);
    if (node.data.kind === 'proxy-chain') {
      changed = true;
      const chain = readProxyChain(node.data);
      if (chain.steps.length < 2)
        throw new Error(node.data.label + ': add at least two chain hops.');
      let via = underlay;
      let exit: RuleNode | undefined;
      chain.steps.forEach((step, index) => {
        const hop = nodeFor(step.outbound, owner);
        exit = emit(hop, owner, via, next);
        via = String(exit.data.settings.tag);
        if (
          index < chain.steps.length - 1 &&
          ['blackhole', 'dns'].includes(
            String(parseJsonObject(String(exit.data.settings.json)).protocol),
          )
        )
          throw new Error(
            node.data.label + ': Block and DNS handlers cannot relay an intermediate chain hop.',
          );
      });
      const config = { ...parseJsonObject(String(exit!.data.settings.json)), tag: allocated.tag };
      const result = materialize(config, allocated.id, node.data.label);
      if (publicRoot) nodes[nodes.findIndex((n) => n.id === node.id)] = result;
      else nodes.push(result);
      built.set(key, result);
      return result;
    }
    if (node.data.kind === 'policy-group') {
      changed = true;
      const groupAllocation = publicRoot && !underlay ? allocated : allocate(owner.id);
      const group = { ...structuredClone(node), id: groupAllocation.id };
      group.data.settings.tag = groupAllocation.tag;
      const sources: PolicySources = structuredClone(readPolicySources(group.data));
      group.data.preparedWeightTags = {};
      const transform = (ref: PolicyReference): PolicyReference => {
        const destination = nodeFor(ref, owner);
        if (!underlay && !isCompositeKind(destination.data.kind)) return ref;
        const prepared = emit(destination, owner, underlay, next);
        group.data.preparedWeightTags![prepared.id] = String(
          ref.type === 'profile'
            ? ref.profile.settings.tag || ref.name
            : destination.data.settings.tag,
        );
        return { type: 'node', nodeId: prepared.id };
      };
      sources.manual = policyReferenceSet(source, node).map(({ reference }) =>
        transform(reference),
      );
      sources.subscriptions = [];
      group.data.settings.selection = 'manual';
      if (group.data.native) delete group.data.native;
      if (sources.fallback) sources.fallback = transform(sources.fallback);
      group.data.settings.sources = JSON.stringify(sources);
      if (publicRoot && !underlay) nodes[nodes.findIndex((n) => n.id === node.id)] = group;
      else nodes.push(group);
      byId.set(group.id, group);
      connectObservation(group, owner);
      if (publicRoot && !underlay) {
        built.set(key, group);
        return group;
      }
      const reinjection = 'wayrill-chain-route-' + group.id;
      rules.push({ type: 'field', inboundTag: [reinjection], balancerTag: groupAllocation.tag });
      const result = materialize(
        { tag: allocated.tag, protocol: 'loopback', settings: { inboundTag: reinjection } },
        allocated.id,
        node.data.label,
      );
      nodes.push(result);
      byId.set(result.id, result);
      built.set(key, result);
      return result;
    }
    const bundle = isExecutableOutboundKind(node.data.kind)
      ? outboundBundle(node.data)
      : [xrayOutboundConfig(node.data)];
    const originalTag = String(node.data.settings.tag);
    const rename = new Map(
      bundle.map((o) => [
        String(o.tag),
        o.tag === originalTag ? allocated.tag : allocate(owner.id).tag,
      ]),
    );
    const rewrite = (value: unknown): unknown =>
      jsonArray(value)
        ? value.map(rewrite)
        : jsonRecord(value)
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [
                k,
                (k === 'tag' || k === 'dialerProxy') && typeof v === 'string'
                  ? (rename.get(v) ?? v)
                  : rewrite(v),
              ]),
            )
          : value;
    let result: RuleNode | undefined;
    for (const outbound of bundle) {
      const config = rewrite(outbound) as Record<string, unknown>;
      if (underlay) {
        const stream = jsonRecord(config.streamSettings) ? config.streamSettings : {};
        const sock = jsonRecord(stream.sockopt) ? stream.sockopt : {};
        const dependency =
          sock.dialerProxy ||
          (jsonRecord(config.proxySettings) ? config.proxySettings.tag : undefined);
        if (dependency && ![...rename.values()].includes(jsonText(dependency)))
          throw new Error(
            node.data.label +
              ': remove its existing external dial-through setting before using it as a chain hop.',
          );
        if (!dependency)
          config.streamSettings = { ...stream, sockopt: { ...sock, dialerProxy: underlay } };
      }
      const id = outbound.tag === originalTag ? allocated.id : allocate(owner.id).id;
      const rendered = materialize(config, id, node.data.label);
      nodes.push(rendered);
      byId.set(id, rendered);
      if (outbound.tag === originalTag) result = rendered;
    }
    if (!result) throw new Error(node.data.label + ': no executable outbound was generated.');
    built.set(key, result);
    return result;
  };
  for (const node of source.nodes) {
    try {
      if (node.data.kind === 'proxy-chain') emit(node, node, undefined, new Set(), true);
      else if (node.data.kind === 'policy-group') {
        const sources = readPolicySources(node.data);
        const refs = [
          ...policyReferenceSet(source, node).map((r) => r.reference),
          ...(sources.fallback ? [sources.fallback] : []),
        ];
        if (refs.some((ref) => isCompositeKind(nodeFor(ref, node).data.kind)))
          emit(node, node, undefined, new Set(), true);
      }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        nodeId: node.id,
        fieldKey: node.data.kind === 'proxy-chain' ? 'steps' : 'sources',
      });
    }
  }
  if (!changed) return { graph: source, rules, origins, references, changed };
  const xray = source.xray && {
    ...source.xray,
    outboundOrder: nodes
      .filter((n) => isOutboundKind(n.data.kind) && n.data.kind !== 'policy-group')
      .map((n) => n.id),
    balancerOrder: nodes.filter((n) => n.data.kind === 'policy-group').map((n) => n.id),
  };
  return {
    graph: { ...source, nodes, edges, ...(xray ? { xray } : {}) },
    rules,
    origins,
    references,
    changed,
  };
}

function preparedDefinition(profile: NonNullable<StashEntry['profile']>): unknown {
  const settings = { ...profile.settings };
  const reference = (ref: PolicyReference): unknown =>
    ref.type === 'node'
      ? ref
      : ref.source
        ? { source: ref.source }
        : { name: ref.name, profile: preparedDefinition(ref.profile) };
  const data = { kind: profile.kind, label: '', description: '', settings };
  if (profile.kind === 'policy-group') {
    const source = readPolicySources(data);
    settings.sources = JSON.stringify({
      manual: source.manual.map(reference),
      subscriptions: source.subscriptions.map((s) => ({ groupId: s.groupId, filter: s.filter })),
      fallback: source.fallback ? reference(source.fallback) : undefined,
    });
  } else if (profile.kind === 'proxy-chain')
    settings.steps = JSON.stringify(
      readProxyChain(data).steps.map((s) => ({ id: s.id, outbound: reference(s.outbound) })),
    );
  return { kind: profile.kind, settings };
}
export function samePreparedDefinition(a: Profile, b: Profile): boolean {
  return jsonEqual(preparedDefinition(a), preparedDefinition(b));
}

import { jsonText, jsonArray, parseJson } from './xrayJson';
import { LIMITS } from '../limits';
import { compactSelectors, prefixMatches } from './prefixSelectors';
import { nativeConfig } from './xrayNodes';
import {
  policyCandidates,
  policyProfileIdentity,
  policySourceProblems,
  readPolicySources,
  resolvePolicyReference,
} from './policySources';
import { outboundBundle, isExecutableOutboundKind } from './outbounds';
import { outboundDependencyProblems } from './protocols';
import type {
  Diagnostic,
  GraphState,
  NodeDefinition,
  RuleNode,
  RuleNodeData,
  SettingDefinition,
} from './types';

const jsonRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !jsonArray(v);
const isXrayOutbound = (n: RuleNode) =>
  isExecutableOutboundKind(n.data.kind) || n.data.kind === 'xray-outbound';
export const isPolicyKind = (kind: string) => kind === 'policy-group' || kind === 'observatory';

export const strategies = ['random', 'roundRobin', 'leastPing', 'leastLoad'] as const;
const jsonField = (
  key: string,
  label: string,
  defaultValue = '',
  help = '',
): SettingDefinition => ({
  key,
  label,
  type: 'json',
  jsonShape: 'object',
  defaultValue,
  maxLength: 65536,
  help,
});
const groupFields: SettingDefinition[] = [
  jsonField('observationSettings', 'Saved observation settings'),
  {
    key: 'tag',
    label: 'Policy group tag',
    type: 'text',
    required: true,
    defaultValue: 'policy-group',
    maxLength: 128,
  },
  {
    key: 'strategy',
    label: 'Selection strategy',
    type: 'select',
    options: [...strategies],
    defaultValue: 'roundRobin',
    optionLabels: {
      random: 'Random',
      roundRobin: 'Round robin',
      leastPing: 'Lowest latency',
      leastLoad: 'Least load',
    },
  },
  {
    key: 'selection',
    label: 'Candidate selection',
    type: 'select',
    options: ['manual', 'subscription', 'combined', 'prefixes'],
    defaultValue: 'manual',
    optionLabels: {
      manual: 'Manual outbound set',
      subscription: 'Filtered subscription groups',
      combined: 'Subscriptions + manual set',
      prefixes: 'Native tag prefixes (advanced)',
    },
  },
  {
    key: 'sources',
    label: 'Outbound sources',
    type: 'json',
    jsonShape: 'object',
    defaultValue: '{"version":1,"manual":[],"subscriptions":[]}',
    maxLength: 64 * 1024 * 1024,
  },
  {
    key: 'selectorPrefixes',
    label: 'Selector prefixes',
    type: 'textarea',
    defaultValue: '',
    maxLength: LIMITS.configBytes,
    help: 'One native Xray outbound-tag prefix per line. Matching graph outbounds are selected internally.',
  },
  {
    key: 'fallbackEnabled',
    label: 'Use a fallback destination',
    type: 'boolean',
    defaultValue: false,
  },
  {
    key: 'observe',
    label: 'Observe candidate health',
    type: 'boolean',
    defaultValue: false,
    help: 'Lowest latency, least load and groups with a fallback require an observatory. Without a fallback, random and round robin do not use probe results for selection.',
  },
  {
    key: 'expected',
    label: 'Expected destination count',
    type: 'number',
    min: 0,
    max: LIMITS.maxOutbounds,
    defaultValue: 1,
  },
  {
    key: 'maxRTT',
    label: 'Maximum RTT',
    type: 'text',
    defaultValue: '0s',
    required: false,
    help: 'A Go duration, e.g. 1s or 500ms. Zero disables the limit.',
  },
  {
    key: 'tolerance',
    label: 'Maximum failure ratio',
    type: 'text',
    defaultValue: '0',
    help: '0 to 1. Zero disables filtering by failure ratio.',
  },
  {
    key: 'baselines',
    label: 'RTT baselines',
    type: 'textarea',
    defaultValue: '',
    help: 'One positive duration per line, e.g. 200ms and 500ms.',
  },
  {
    ...jsonField(
      'costs',
      'Destination weights',
      '',
      'Array of {"match":"tag-text","regexp":false,"value":1}. First match wins; text matches a substring, regexp uses Go syntax. Zero extracts a number from the matched text.',
    ),
    jsonShape: 'array',
  },
  jsonField('strategyExtra', 'Additional strategy settings'),
  jsonField('extra', 'Additional balancer fields'),
];
const observerFields: SettingDefinition[] = [
  {
    key: 'mode',
    label: 'Observatory mode',
    type: 'select',
    options: ['standard', 'burst'],
    defaultValue: 'standard',
    optionLabels: { standard: 'Standard latency probes', burst: 'Burst health sampling' },
  },
  {
    key: 'subjects',
    label: 'Observed destinations',
    type: 'select',
    options: ['groups', 'prefixes'],
    defaultValue: 'groups',
    optionLabels: { groups: 'Connected policy groups', prefixes: 'Native tag prefixes' },
  },
  {
    key: 'selectorPrefixes',
    label: 'Observed tag prefixes',
    type: 'textarea',
    defaultValue: '',
    maxLength: LIMITS.configBytes,
  },
  {
    key: 'probeURL',
    label: 'Probe URL',
    type: 'text',
    required: true,
    defaultValue: 'https://www.gstatic.com/generate_204',
    maxLength: 4096,
  },
  { key: 'probeInterval', label: 'Probe interval', type: 'text', defaultValue: '30s' },
  {
    key: 'enableConcurrency',
    label: 'Probe destinations concurrently',
    type: 'boolean',
    defaultValue: true,
  },
  {
    key: 'destination',
    label: 'Health probe destination',
    type: 'text',
    defaultValue: 'https://www.gstatic.com/generate_204',
    maxLength: 4096,
  },
  {
    key: 'connectivity',
    label: 'Connectivity test URL',
    type: 'text',
    required: false,
    defaultValue: '',
    maxLength: 4096,
    help: 'Optional direct system connectivity check, bypassing observed outbounds. Leave empty when direct Internet access is restricted.',
  },
  {
    key: 'interval',
    label: 'Sample interval',
    type: 'text',
    defaultValue: '30s',
    help: 'Xray uses at least 10s. A health window spans interval × sample count.',
  },
  {
    key: 'sampling',
    label: 'Samples per health window',
    type: 'number',
    min: 1,
    max: 1000,
    defaultValue: 5,
  },
  { key: 'timeout', label: 'Probe timeout', type: 'text', defaultValue: '5s' },
  {
    key: 'httpMethod',
    label: 'Probe HTTP method',
    type: 'select',
    options: ['HEAD', 'GET'],
    defaultValue: 'HEAD',
  },
  jsonField('healthExtra', 'Additional health-check settings'),
  jsonField('extra', 'Additional observatory fields'),
];
for (const f of groupFields)
  if (['expected', 'maxRTT', 'tolerance', 'baselines', 'costs'].includes(f.key))
    f.visibleWhen = { strategy: 'leastLoad' };
for (const f of observerFields)
  if (['probeURL', 'probeInterval', 'enableConcurrency'].includes(f.key))
    f.visibleWhen = { mode: 'standard' };
  else if (
    [
      'destination',
      'connectivity',
      'interval',
      'sampling',
      'timeout',
      'httpMethod',
      'healthExtra',
    ].includes(f.key)
  )
    f.visibleWhen = { mode: 'burst' };
export const policyDefinitions: NodeDefinition[] = [
  {
    kind: 'policy-group',
    title: 'Policy group',
    group: 'Outbounds',
    category: 'outbound',
    summary:
      'Outbound policy with filtered subscriptions, manual candidates and health-based selection',
    fields: groupFields,
    defaults: Object.fromEntries(groupFields.map((f) => [f.key, f.defaultValue!])),
  },
  {
    kind: 'observatory',
    title: 'Observatory',
    group: 'Rules & filters',
    category: 'rule',
    summary: 'Shared latency probes or burst health sampling',
    fields: observerFields,
    defaults: Object.fromEntries(observerFields.map((f) => [f.key, f.defaultValue!])),
  },
];
export const policyNeedsObservation = (data: RuleNodeData) =>
  ['leastPing', 'leastLoad'].includes(String(data.settings.strategy)) ||
  data.settings.fallbackEnabled === true ||
  data.settings.observe === true;
const lines = (v: unknown) =>
  jsonText(v ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
export function policyPorts(data: RuleNodeData): { id: string; name: string }[] {
  return ['policy-group', 'proxy-chain'].includes(data.kind)
    ? [{ id: 'observation', name: 'Observation' }]
    : [];
}
const extras = (data: RuleNodeData, key: string, reserved: string[]) => {
  const value = data.settings[key] ? parseJson(String(data.settings[key])) : {};
  if (
    !jsonRecord(value) ||
    Object.keys(value).some(
      (k) => reserved.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k),
    )
  )
    throw new Error(`Invalid ${key}: use a JSON object without mapped fields.`);
  return value;
};
const durationValue = (s: string) => {
  if (s === '0') return 0;
  if (!s || !/^(?:\d+(?:\.\d+)?(?:ns|us|\u00b5s|\u03bcs|ms|s|m|h))+$/.test(s)) return NaN;
  const scale: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    '\u00b5s': 1e-6,
    '\u03bcs': 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600,
  };
  const value = [...s.matchAll(/(\d+(?:\.\d+)?)(ns|us|\u00b5s|\u03bcs|ms|s|m|h)/g)].reduce(
    (total, m) => total + Number(m[1]) * scale[m[2]],
    0,
  );
  return Number.isFinite(value) && value <= 9223372036 ? value : NaN;
};
export function policyProblems(data: RuleNodeData): Diagnostic[] {
  if (!['policy-group', 'observatory'].includes(data.kind)) return [];
  const issues: Diagnostic[] = [],
    s = data.settings;
  const add = (fieldKey: string, message: string, severity: Diagnostic['severity'] = 'error') =>
    issues.push({ fieldKey, message, severity });
  try {
    if (data.kind === 'policy-group') {
      readPolicySources(data);
      if (!String(s.tag).trim()) add('tag', 'Give the policy group a tag.');
      if (s.selection === 'prefixes' && !lines(s.selectorPrefixes).length)
        add('selectorPrefixes', 'Enter at least one native tag prefix.');
      if (s.strategy === 'leastLoad') {
        if (!(durationValue(String(s.maxRTT)) >= 0)) add('maxRTT', 'Use a nonnegative duration.');
        if (
          !String(s.tolerance).trim() ||
          !Number.isFinite(Number(s.tolerance)) ||
          Number(s.tolerance) < 0 ||
          Number(s.tolerance) > 1
        )
          add('tolerance', 'Use a failure ratio from 0 to 1.');
        if (lines(s.baselines).some((v) => !(durationValue(v) > 0)))
          add('baselines', 'Baselines must be positive durations.');
        if (s.costs) {
          const weights: unknown = parseJson(String(s.costs));
          if (
            !jsonArray(weights) ||
            weights.some(
              (w) =>
                !jsonRecord(w) ||
                typeof w.match !== 'string' ||
                !w.match ||
                typeof w.regexp !== 'boolean' ||
                typeof w.value !== 'number' ||
                !Number.isFinite(w.value) ||
                w.value < 0,
            )
          )
            add('costs', 'Use an array of match, regexp and nonnegative numeric value fields.');
        }
      }
      extras(data, 'extra', ['tag', 'selector', 'strategy', 'fallbackTag']);
      extras(data, 'strategyExtra', ['costs', 'baselines', 'expected', 'maxRTT', 'tolerance']);
      if (['leastPing', 'leastLoad'].includes(String(s.strategy)) && !s.fallbackEnabled)
        add(
          'fallbackEnabled',
          'Without a fallback, a group with no healthy candidate cannot route traffic.',
          'warning',
        );
    } else {
      if (s.subjects === 'prefixes' && !lines(s.selectorPrefixes).length)
        add('selectorPrefixes', 'Enter at least one observed tag prefix.');
      for (const key of s.mode === 'standard' ? ['probeURL'] : ['destination', 'connectivity']) {
        if (!s[key]) continue;
        try {
          const url = new URL(String(s[key]));
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new Error();
        } catch {
          add(key, 'Use an HTTP(S) probe URL without credentials or a fragment.');
        }
      }
      for (const key of s.mode === 'standard' ? ['probeInterval'] : ['interval', 'timeout'])
        if (!(durationValue(String(s[key])) > 0))
          add(key, 'Use a positive duration, e.g. 30s or 500ms.');
      if (
        s.mode === 'burst' &&
        durationValue(String(s.interval)) > 0 &&
        durationValue(String(s.interval)) < 10
      )
        add('interval', 'Xray raises burst sample intervals below 10s to 10s.', 'warning');
      extras(data, 'extra', [
        'subjectSelector',
        'probeURL',
        'probeInterval',
        'enableConcurrency',
        'pingConfig',
      ]);
      extras(data, 'healthExtra', [
        'destination',
        'connectivity',
        'interval',
        'sampling',
        'timeout',
        'httpMethod',
      ]);
    }
  } catch (e) {
    add('sources', e instanceof Error ? e.message : 'Invalid policy settings.');
  }
  return issues;
}
// Candidate and fallback references live inside the group; only observation is a wire.
export function editPolicyGraph(
  graph: GraphState,
  nodeId: string,
  settings: RuleNodeData['settings'],
  observerId?: string,
  observer?: RuleNode,
): GraphState {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || !(isPolicyKind(node.data.kind) || node.data.kind === 'proxy-chain'))
    throw new Error('Policy node no longer exists.');
  const nodes = graph.nodes.map((n) =>
    n.id === nodeId
      ? { ...n, data: { ...n.data, settings } }
      : observer?.id === n.id
        ? observer
        : n,
  );
  if (observer && !nodes.some((n) => n.id === observer.id)) nodes.push(observer);
  const edges = graph.edges.filter((e) => e.source !== nodeId);
  if (['policy-group', 'proxy-chain'].includes(node.data.kind) && observerId) {
    edges.push({
      id:
        graph.edges.find(
          (e) => e.source === nodeId && e.target === observerId && e.sourceHandle === 'observation',
        )?.id ?? crypto.randomUUID(),
      source: nodeId,
      sourceHandle: 'observation',
      target: observerId,
      targetHandle: 'in',
    });
  }
  return { ...graph, nodes, edges };
}

export function policyGraphProblems(graph: GraphState): Diagnostic[] {
  const issues: Diagnostic[] = [],
    groups = graph.nodes.filter((n) => n.data.kind === 'policy-group');
  for (const group of groups) {
    if (groups.some((n) => n.id !== group.id && n.data.settings.tag === group.data.settings.tag))
      issues.push({
        severity: 'error',
        nodeId: group.id,
        fieldKey: 'tag',
        message: `${group.data.label}: another policy group uses this tag.`,
      });
    try {
      issues.push(...policySourceProblems(graph, group));
    } catch {
      /* Policy field checks report malformed sources. */
    }
    if (
      policyNeedsObservation(group.data) &&
      !graph.edges.some((e) => e.source === group.id && e.sourceHandle === 'observation')
    )
      issues.push({
        severity: 'error',
        nodeId: group.id,
        fieldKey: 'observe',
        message: `${group.data.label}: connect Observatory before running.`,
      });
  }
  return issues;
}

export interface PolicyCompilation {
  rules?: Record<string, unknown>[];
  displayNames: Record<string, string>;
  balancers: Record<string, unknown>[];
  outbounds: Record<string, unknown>[];
  observation: Record<string, unknown>;
  warnings: string[];
}
export function compilePolicies(
  graph: GraphState,
  available: Record<string, unknown>[],
): PolicyCompilation {
  const groups = graph.nodes.filter((n) => n.data.kind === 'policy-group'),
    observers = graph.nodes.filter((n) => n.data.kind === 'observatory');
  const displayNames = new Map<string, string>();
  const extraOutbounds: Record<string, unknown>[] = [],
    usedTags = new Set(available.map((o) => String(o.tag))),
    aliases = new Map<string, string>(),
    observedGroups = new Map<string, string>(),
    tagSet = new Set<string>(),
    warnings: string[] = [];
  const destination = (id: string, port: string) => {
    const matches = graph.edges.filter((e) => e.source === id && e.sourceHandle === port);
    const target = matches.length === 1 && graph.nodes.find((n) => n.id === matches[0].target);
    if (!target) throw new Error('Connect the policy group to its observatory.');
    return target;
  };
  const groupCandidates = new Map(groups.map((g) => [g.id, policyCandidates(graph, g)]));
  const availableByTag = new Map(available.map((o) => [o.tag, o]));
  const profileNodes = new Map<string, RuleNode>();
  const identities = new Map<string, string>(),
    originalTags = new Map<string, Set<string>>();
  const addProfile = (node: RuleNode, profile: import('../profiles/import').Profile) => {
    if (graph.nodes.some((n) => n.id === node.id))
      throw new Error('A graph node ID conflicts with an internal policy profile.');
    const identity = policyProfileIdentity(profile),
      previous = identities.get(node.id);
    if (previous && previous !== identity)
      throw new Error('Policy profile identity collision; the outbound set was not changed.');
    identities.set(node.id, identity);
    profileNodes.set(node.id, node);
    const original = String(profile.settings.tag ?? '');
    if (original) {
      const tags = originalTags.get(original) ?? new Set<string>();
      tags.add(String(node.data.settings.tag));
      originalTags.set(original, tags);
    }
  };
  for (const group of groups) {
    const sources = readPolicySources(group.data);
    for (const { node, reference } of groupCandidates.get(group.id)!)
      if (reference.type === 'profile') addProfile(node, reference.profile);
    if (group.data.settings.fallbackEnabled && sources.fallback?.type === 'profile') {
      const node = resolvePolicyReference(graph, sources.fallback);
      addProfile(node, sources.fallback.profile);
    }
  }
  const dependencyTag = (tag: string, node: RuleNode) => {
    const targets = new Set(originalTags.get(tag));
    if (usedTags.has(tag)) targets.add(tag);
    if (targets.size > 1)
      throw new Error(
        `${node.data.label}: dial-through tag ${tag} matches multiple selected configurations. Use distinct source tags.`,
      );
    if (!targets.size && !usedTags.has(tag))
      throw new Error(
        `${node.data.label}: dial-through destination ${tag} is missing from the outbound set and graph.`,
      );
    return [...targets][0] ?? tag;
  };
  const rewriteBundle = (node: RuleNode, tag: string) => {
    const native = node.data.native && availableByTag.get(node.data.settings.tag);
    const bundle = native
      ? [{ ...native, tag }]
      : node.data.kind === 'xray-outbound'
        ? [{ ...nativeConfig(node.data), tag }]
        : outboundBundle({ ...node.data, settings: { ...node.data.settings, tag } });
    const rename = new Map(
      bundle
        .filter((o) => o.tag !== tag)
        .map((o, i) => [
          String(o.tag),
          tag.startsWith('wayrill-observed-')
            ? `wayrill-monitor-inner-${node.id}-${i}`
            : `wayrill-policy-inner-${node.id}-${i}`,
        ]),
    );
    const rewrite = (v: unknown): unknown =>
      jsonArray(v)
        ? v.map(rewrite)
        : jsonRecord(v)
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [
                k,
                (k === 'tag' || k === 'dialerProxy') && typeof x === 'string'
                  ? (rename.get(x) ?? x)
                  : typeof x === 'object'
                    ? rewrite(x)
                    : x,
              ]),
            )
          : v;
    for (const item of bundle.map((o) => rewrite(o) as Record<string, unknown>)) {
      if (profileNodes.has(node.id)) {
        const stream = item.streamSettings,
          sock = jsonRecord(stream) ? stream.sockopt : undefined,
          proxy = item.proxySettings;
        if (
          jsonRecord(sock) &&
          typeof sock.dialerProxy === 'string' &&
          !rename.has(sock.dialerProxy) &&
          ![...rename.values()].includes(sock.dialerProxy)
        )
          sock.dialerProxy = dependencyTag(sock.dialerProxy, node);
        if (jsonRecord(proxy) && typeof proxy.tag === 'string')
          proxy.tag = dependencyTag(proxy.tag, node);
      }
      if (usedTags.has(String(item.tag)))
        throw new Error('Generated policy destination conflicts with an existing tag.');
      usedTags.add(String(item.tag));
      extraOutbounds.push(item);
      displayNames.set(
        String(item.tag),
        item.tag === tag ? node.data.label : `${node.data.label} (transport)`,
      );
    }
  };
  for (const node of profileNodes.values()) rewriteBundle(node, String(node.data.settings.tag));
  const allAvailable = [...available, ...extraOutbounds];
  const balancers = groups.map((group) => {
    const data = group.data,
      s = data.settings,
      tag = String(s.tag);
    const problems = policyProblems(data).filter((p) => p.severity === 'error');
    if (problems.length)
      throw new Error(`${data.label}: ${problems.map((p) => p.message).join(' ')}`);
    if (tagSet.has(tag)) throw new Error(`${data.label}: another policy group uses this tag.`);
    tagSet.add(tag);
    const candidates = groupCandidates.get(group.id)!,
      targets = candidates.map((c) => c.node);
    warnings.push(
      ...policySourceProblems(graph, group)
        .filter((p) => p.severity === 'warning')
        .map((p) => p.message),
    );
    if (targets.some((n) => !isXrayOutbound(n)))
      throw new Error(
        `${data.label}: candidates must be executable outbound nodes; nested policy groups are unsupported by Xray.`,
      );
    let selectors =
      s.selection === 'prefixes'
        ? lines(s.selectorPrefixes)
        : targets.map((n) => String(n.data.settings.tag));
    if (!selectors.length && s.fallbackEnabled) selectors = [`wayrill-policy-empty-${group.id}`];
    if (!selectors.length || (!targets.length && !s.fallbackEnabled))
      throw new Error(`${data.label}: no candidate destinations match this group.`);
    if (s.selection === 'prefixes') {
      const actual = allAvailable
        .filter((o) => selectors.some((p) => String(o.tag).startsWith(p)))
        .map((o) => String(o.tag));
      const drawn = new Set(targets.map((n) => String(n.data.settings.tag)));
      if (actual.length !== drawn.size || actual.some((t) => !drawn.has(t)))
        throw new Error(
          `${data.label}: native selectors select generated destinations outside this outbound set.`,
        );
    } else {
      // Native selectors match prefixes. Introduce aliases only where a selected
      // tag would also select an unselected or generated outbound.
      const selected = new Set(selectors);
      const excluded = allAvailable
        .map((o) => String(o.tag))
        .filter((t) => !selected.has(t))
        .sort();
      selectors = targets.map((n) => {
        const tag = String(n.data.settings.tag);
        if (
          !'wayrill-policy-'.startsWith(tag) &&
          !'wayrill-observed-'.startsWith(tag) &&
          !'wayrill-telemetry-'.startsWith(tag) &&
          !tag.startsWith('wayrill-telemetry-') &&
          !prefixMatches(excluded, tag)
        )
          return tag;
        const alias = `wayrill-policy-member-${n.id.length}-${n.id}`;
        if (!aliases.has(n.id)) {
          rewriteBundle(n, alias);
          aliases.set(n.id, alias);
        }
        warnings.push(
          `${data.label}: a separate core destination preserves exact membership for ${n.data.label}.`,
        );
        return alias;
      });
    }
    if (!selectors.length && s.fallbackEnabled) selectors = [`wayrill-policy-empty-${group.id}`];
    let fallback: string | undefined;
    if (s.fallbackEnabled) {
      const ref = readPolicySources(data).fallback;
      if (!ref) throw new Error(`${data.label}: choose a fallback outbound.`);
      const node = resolvePolicyReference(graph, ref);
      if (!isXrayOutbound(node))
        throw new Error(`${data.label}: fallback must be an executable outbound.`);
      fallback = String(node.data.settings.tag);
    }
    if (
      policyNeedsObservation(data) ||
      graph.edges.some((e) => e.source === group.id && e.sourceHandle === 'observation')
    ) {
      const observer = destination(group.id, 'observation');
      if (observer.data.kind !== 'observatory')
        throw new Error(
          `${data.label}: connect its Observation port to the shared observatory node.`,
        );
      observedGroups.set(tag, observer.id);
    }
    let costs = s.costs
      ? (parseJson(String(s.costs)) as { match: string; regexp: boolean; value: number }[])
      : [];
    if (s.strategy === 'leastLoad' && costs.length) {
      const remapped = candidates.filter(
        ({ node: n }) =>
          aliases.has(n.id) ||
          profileNodes.has(n.id) ||
          (data.preparedWeightTags && Object.hasOwn(data.preparedWeightTags, n.id)),
      );
      if (remapped.length && costs.some((w) => w.regexp))
        throw new Error(
          `${data.label}: regular-expression weights need unambiguous outbound tags or native-prefix selection; a generated alias would change their meaning.`,
        );
      const weights = remapped.map(({ node: n, weightTag }) => {
        const weight = costs.find((w) => weightTag.includes(w.match));
        const value = weight
          ? weight.value > 0
            ? weight.value
            : Number(weight.match.match(/\d+(\.\d+)?/)?.[0] ?? 1)
          : 1;
        if (value === 0)
          throw new Error(
            `${data.label}: an automatic zero weight requires unambiguous outbound tags or native-prefix selection.`,
          );
        return { match: `^${aliases.get(n.id) ?? n.data.settings.tag}$`, regexp: true, value };
      });
      costs = [...weights, ...costs];
    }
    const least =
      s.strategy === 'leastLoad'
        ? {
            expected: s.expected,
            maxRTT: s.maxRTT,
            tolerance: Number(s.tolerance),
            ...(s.baselines ? { baselines: lines(s.baselines) } : {}),
            ...(costs.length ? { costs } : {}),
          }
        : {};
    const settings = {
      ...least,
      ...extras(data, 'strategyExtra', ['costs', 'baselines', 'expected', 'maxRTT', 'tolerance']),
    };
    const projection = {
      tag,
      selector: [...new Set(selectors)],
      strategy: { type: s.strategy, ...(Object.keys(settings).length ? { settings } : {}) },
      ...(fallback ? { fallbackTag: fallback } : {}),
      ...extras(data, 'extra', ['tag', 'selector', 'strategy', 'fallbackTag']),
    };
    return projection;
  });
  // Choose prefixes only after every group and alias is built. No prefix may
  // accidentally include a destination created by a later group.
  const subjectsByObserver = new Map(observers.map((o) => [o.id, [] as string[]]));
  // Isolated aliases prevent prefix selectors from probing similarly named
  // outbounds, and expose one report for the complete chain's public route.
  for (const node of graph.nodes) {
    if (!isXrayOutbound(node) || node.data.kind === 'block-outbound') continue;
    const link = graph.edges.find((e) => e.source === node.id && e.sourceHandle === 'observation');
    if (!link) continue;
    const subjects = subjectsByObserver.get(link.target);
    if (!subjects) throw new Error(`${node.data.label}: connect Observation to an observatory.`);
    const tag = `wayrill-observed-${node.data.settings.tag}`;
    rewriteBundle(node, tag);
    subjects.push(tag);
  }
  const finalTags = [...usedTags];
  for (const [i, group] of groups.entries()) {
    const selectors = balancers[i].selector;
    if (group.data.settings.selection === 'prefixes') {
      const expected = new Set(
        groupCandidates.get(group.id)!.map((c) => String(c.node.data.settings.tag)),
      );
      const actual = finalTags.filter((t) => selectors.some((p) => t.startsWith(p)));
      if (actual.length !== expected.size || actual.some((t) => !expected.has(t)))
        throw new Error(
          `${group.data.label}: native selectors include generated destinations outside this outbound set.`,
        );
    } else if (selectors.length >= 128) {
      balancers[i].selector = compactSelectors(selectors, finalTags);
    }
  }
  for (const balancer of balancers) {
    const observer = observedGroups.get(balancer.tag);
    if (observer) subjectsByObserver.get(observer)?.push(...balancer.selector);
  }
  const observation: Record<string, unknown> = {};
  let shared: string | undefined;
  for (const observer of observers) {
    const data = observer.data,
      s = data.settings;
    const observerSubjects = subjectsByObserver.get(observer.id)!;
    if (s.subjects !== 'prefixes' && !observerSubjects.length) {
      warnings.push(`${data.label}: no observed outbounds are connected; observation is inactive.`);
      continue;
    }
    const problems = policyProblems(data).filter((p) => p.severity === 'error');
    if (problems.length)
      throw new Error(`${data.label}: ${problems.map((p) => p.message).join(' ')}`);
    const subjects =
      s.subjects === 'prefixes' ? lines(s.selectorPrefixes) : [...new Set(observerSubjects)];
    // Exact-path monitoring aliases are also required in native-prefix mode.
    // Prefixes continue to control native candidates; drawn paths stay observable.
    subjects.push(...observerSubjects.filter((tag) => tag.startsWith('wayrill-observed-')));
    if (!subjects.length)
      throw new Error(`${data.label}: choose observed outbounds or tag prefixes.`);
    if (s.subjects === 'prefixes')
      for (const tag of usedTags)
        if (
          observerSubjects.some((p) => tag.startsWith(p)) &&
          !subjects.some((p) => tag.startsWith(p))
        )
          throw new Error(`${data.label}: observed selectors omit a policy-group candidate.`);
    const projection =
      s.mode === 'standard'
        ? {
            subjectSelector: subjects,
            probeURL: s.probeURL,
            probeInterval: s.probeInterval,
            enableConcurrency: s.enableConcurrency,
            ...extras(data, 'extra', [
              'subjectSelector',
              'probeURL',
              'probeInterval',
              'enableConcurrency',
              'pingConfig',
            ]),
          }
        : {
            subjectSelector: subjects,
            pingConfig: {
              destination: s.destination,
              ...(s.connectivity ? { connectivity: s.connectivity } : {}),
              interval: s.interval,
              sampling: s.sampling,
              timeout: s.timeout,
              httpMethod: s.httpMethod,
              ...extras(data, 'healthExtra', [
                'destination',
                'connectivity',
                'interval',
                'sampling',
                'timeout',
                'httpMethod',
              ]),
            },
            ...extras(data, 'extra', [
              'subjectSelector',
              'probeURL',
              'probeInterval',
              'enableConcurrency',
              'pingConfig',
            ]),
          };
    const key = s.mode === 'standard' ? 'observatory' : 'burstObservatory';
    const options = { ...projection, subjectSelector: undefined };
    const signature = JSON.stringify([key, options]);
    if (shared && shared !== signature)
      throw new Error(
        `${data.label}: Xray uses one observation provider. Use matching probe settings or connect outbounds to the same Observatory.`,
      );
    shared = signature;
    const previous = observation[key] as { subjectSelector: string[] } | undefined;
    observation[key] = {
      ...projection,
      subjectSelector: [...new Set([...(previous?.subjectSelector ?? []), ...subjects])],
    };
  }
  const dependency = outboundDependencyProblems({
    outbounds: [...available, ...extraOutbounds],
  }).find((p) => extraOutbounds.some((o) => o.tag === p.tag));
  if (dependency) throw new Error(`Policy outbound ${dependency.tag}: ${dependency.message}`);
  return {
    balancers,
    outbounds: extraOutbounds,
    displayNames: Object.fromEntries(displayNames),
    observation,
    warnings: [...new Set(warnings)],
  };
}

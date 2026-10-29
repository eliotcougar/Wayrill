import { policyProfileId, policyProfileIdentity, stableProfileKey } from './profileIdentity';
export { policyProfileId, policyProfileIdentity } from './profileIdentity';
import { jsonArray, parseJson } from './xrayJson';
import { allOutboundNodes } from './nativePool';
import { LIMITS, OUTBOUND_LIMIT_LABEL } from '../limits';
import { getDefinition, makeNode, validateSettings } from './catalog';
import { bindingsFor, resolveNodeData } from './defaults';
import { isOutboundKind, outboundProblems } from './outbounds';
import { fieldProblem } from './settingValidation';
import type { Profile, Stash, StashEntry, StashGroup } from '../profiles/import';
import type { Diagnostic, GraphState, RuleNode, RuleNodeData, StashLink } from './types';
import { findStashEntry } from '../profiles/stashModel';

export interface PolicyProfile {
  source?: StashLink;
  type: 'profile';
  id: string;
  name: string;
  profile: Profile;
}
export type PolicyReference = { type: 'node'; nodeId: string } | PolicyProfile;
export interface PolicyFilter {
  name: string;
  exclude: string;
  address: string;
  protocol: string;
  mode: 'contains' | 'glob';
}
export interface PolicySubscription {
  groupId: string;
  name: string;
  filter: PolicyFilter;
  entries: PolicyProfile[];
  updatedAt: number | null;
  rejected: number;
  missing: boolean;
}
export interface PolicySources {
  version: 1;
  manual: PolicyReference[];
  subscriptions: PolicySubscription[];
  fallback?: PolicyReference;
}
export interface PolicyCandidate {
  node: RuleNode;
  reference: PolicyReference;
  origin: string;
  weightTag: string;
}

export const emptyPolicySources = (): PolicySources => ({
  version: 1,
  manual: [],
  subscriptions: [],
});
export const emptyPolicyFilter = (): PolicyFilter => ({
  name: '',
  exclude: '',
  address: '',
  protocol: '',
  mode: 'contains',
});
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !jsonArray(v);
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length <= max;
const id = (v: unknown): v is string => text(v) && /^[\w-]{1,128}$/.test(v);
const sourceCache = new WeakMap<RuleNodeData['settings'], { json: string; value: PolicySources }>();

export function validPolicyReference(v: unknown): v is PolicyReference {
  if (!record(v)) return false;
  if (v.type === 'node') return id(v.nodeId);
  return (
    v.type === 'profile' &&
    (v.source === undefined ||
      (record(v.source) && text(v.source.groupId, 256) && text(v.source.entryId, 256))) &&
    text(v.id, 32) &&
    /^[a-f0-9]{32}$/.test(v.id) &&
    text(v.name) &&
    !!v.name.trim() &&
    record(v.profile) &&
    isOutboundKind(String(v.profile.kind)) &&
    record(v.profile.settings) &&
    Object.values(v.profile.settings).every(
      (s) =>
        ['string', 'number', 'boolean'].includes(typeof s) &&
        (typeof s !== 'number' || Number.isFinite(s)),
    ) &&
    JSON.stringify(v.profile).length <=
      (['policy-group', 'proxy-chain'].includes(String(v.profile.kind))
        ? 64 * 1024 * 1024
        : 128 * 1024)
  );
}
export function readPolicySources(data: RuleNodeData): PolicySources {
  const json = String(data.settings.sources ?? '');
  const previous = sourceCache.get(data.settings);
  if (previous?.json === json) return previous.value;
  const v: unknown = parseJson(json);
  if (
    !record(v) ||
    v.version !== 1 ||
    !jsonArray(v.manual) ||
    v.manual.length > 50000 ||
    !v.manual.every(validPolicyReference) ||
    !jsonArray(v.subscriptions) ||
    v.subscriptions.length > 500 ||
    (v.fallback !== undefined && !validPolicyReference(v.fallback))
  )
    throw new Error('Invalid policy-group outbound sources.');
  const groups = new Set<string>();
  let total = v.manual.length;
  for (const s of v.subscriptions) {
    const filter = record(s) && record(s.filter) ? s.filter : {};
    if (
      !record(s) ||
      !text(s.groupId, 256) ||
      !s.groupId ||
      groups.has(s.groupId) ||
      !text(s.name) ||
      !record(s.filter) ||
      !['contains', 'glob'].includes(String(s.filter.mode)) ||
      !['name', 'exclude', 'address', 'protocol'].every((k) => text(filter[k], 4096)) ||
      !jsonArray(s.entries) ||
      !s.entries.every((e) => validPolicyReference(e) && e.type === 'profile') ||
      !(
        s.updatedAt === null ||
        (typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt))
      ) ||
      typeof s.missing !== 'boolean' ||
      typeof s.rejected !== 'number' ||
      !Number.isInteger(s.rejected) ||
      s.rejected < 0
    )
      throw new Error('Invalid filtered subscription source.');
    groups.add(s.groupId);
    total += s.entries.length;
  }
  if (total > 50000) throw new Error('A policy group supports at most 50,000 source entries.');
  const value = v as unknown as PolicySources;
  sourceCache.set(data.settings, { json, value });
  return value;
}

export function policyProfile(entry: StashEntry, source?: StashLink): PolicyProfile {
  if (!entry.profile) throw new Error(entry.problem || 'This stash entry is unsupported.');
  return {
    type: 'profile',
    id: policyProfileId(entry.profile),
    name: entry.name,
    profile: structuredClone(entry.profile),
    ...(source ? { source } : {}),
  };
}

const terms = (v: string) =>
  v
    .split(/\r?\n/)
    .map((s) => s.trim().toLocaleLowerCase('en'))
    .filter(Boolean);
// Glob matching without a regular expression; user patterns cannot create regex backtracking.
function glob(value: string, pattern: string): boolean {
  let i = 0,
    p = 0,
    star = -1,
    retry = 0;
  while (i < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[i])) {
      i++;
      p++;
    } else if (pattern[p] === '*') {
      star = p++;
      retry = i;
    } else if (star >= 0) {
      p = star + 1;
      i = ++retry;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function filterPolicyEntries(group: StashGroup, filter: PolicyFilter): StashEntry[] {
  const include = terms(filter.name),
    exclude = terms(filter.exclude),
    address = terms(filter.address);
  const match = (v: string, patterns: string[]) =>
    patterns.some((p) => (filter.mode === 'glob' ? glob(v, p) : v.includes(p)));
  return group.entries.filter((entry) => {
    if (entry.retained) return false;
    const name = entry.name.toLocaleLowerCase('en'),
      host = entry.address.toLocaleLowerCase('en');
    return (
      (!include.length || match(name, include)) &&
      (!exclude.length || !match(name, exclude)) &&
      (!address.length || match(host, address)) &&
      (!filter.protocol || entry.protocol.toLowerCase() === filter.protocol.toLowerCase())
    );
  });
}
export function subscriptionSource(group: StashGroup): PolicySubscription {
  return {
    groupId: group.id,
    name: group.name,
    filter: emptyPolicyFilter(),
    entries: [],
    updatedAt: group.updatedAt,
    rejected: 0,
    missing: false,
  };
}
// An unchanged immutable stash entry is copied/hashed once, even when several
// linked groups and filter drafts select it. The graph still saves a full snapshot.
const profileSnapshots = new WeakMap<StashEntry, PolicyProfile>();
const subscriptionSnapshots = new WeakMap<StashGroup, Map<string, PolicySubscription>>();
/** Health timestamps/latency are not policy membership inputs. */
export function reusePolicyMembership(before: StashGroup, after: StashGroup) {
  const cached = subscriptionSnapshots.get(before);
  if (cached) subscriptionSnapshots.set(after, cached);
}
const compositeSnapshots = new WeakMap<StashEntry, PolicyProfile>();

// Only a successfully checked local preview may prime these caches. Imported
// graph files still pass readPolicySources and ordinary compiler validation.
export function cachePolicyPreview(
  data: RuleNodeData,
  sources: PolicySources,
  serialized: string,
  stash: Stash,
) {
  if (data.settings.sources !== serialized)
    throw new Error('The prepared policy snapshot does not match this draft.');
  sourceCache.set(data.settings, { json: serialized, value: sources });
  for (const source of sources.subscriptions) {
    const group = stash.groups.find((g) => g.id === source.groupId);
    if (
      !group ||
      source.missing ||
      group.name !== source.name ||
      group.updatedAt !== source.updatedAt
    )
      continue;
    const snapshots = subscriptionSnapshots.get(group) ?? new Map<string, PolicySubscription>();
    if (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(JSON.stringify(source.filter), source);
    subscriptionSnapshots.set(group, snapshots);
  }
}
import { readProxyChain } from './proxyChains';

export function refreshPolicySources(
  sources: PolicySources,
  stash: Stash,
  depth = 0,
  scope?: ReadonlySet<string>,
  availability?: ReadonlySet<string>,
): PolicySources {
  if (depth >= 16) throw new Error('Prepared outbounds exceed 16 nested levels.');
  const groups = new Map(stash.groups.map((group) => [group.id, group]));
  let changed = false;
  const subscriptions = sources.subscriptions.map((source) => {
    if (scope && !scope.has(source.groupId)) return source;
    const group = groups.get(source.groupId);
    if (!group) {
      if (source.missing) return source;
      changed = true;
      return { ...source, missing: true };
    }
    if (availability) {
      // Health changes membership, never saved connection definitions. Keep
      // untouched snapshots, and reject results for an edited connection.
      const entries = new Map<string | PolicyProfile, PolicyProfile>(
        source.entries.map((entry) => [entry.source?.entryId ?? entry, entry]),
      );
      const candidates = new Map(
        filterPolicyEntries(group, source.filter).map((entry) => [entry.id, entry]),
      );
      const current = new Map(group.entries.map((entry) => [entry.id, entry]));
      let membershipChanged = false;
      for (const id of availability) {
        const old = entries.get(id),
          entry = current.get(id);
        if (old && entry?.profile && policyProfileId(entry.profile) !== old.id) continue;
        const candidate = candidates.get(id);
        if (!candidate?.profile) {
          const removed = entries.delete(id);
          membershipChanged ||= removed;
        } else if (!old) {
          entries.set(id, policyProfile(candidate, { groupId: group.id, entryId: id }));
          membershipChanged = true;
        }
      }
      if (!membershipChanged) return source;
      changed = true;
      return { ...source, entries: [...entries.values()] };
    }
    let cache = subscriptionSnapshots.get(group);
    if (!cache) {
      cache = new Map();
      subscriptionSnapshots.set(group, cache);
    }
    const key = JSON.stringify(source.filter);
    let next = cache.get(key);
    if (!next) {
      const matches = filterPolicyEntries(group, source.filter);
      const entries: PolicyProfile[] = [];
      let rejected = 0;
      for (const entry of matches) {
        if (!entry.profile) {
          rejected++;
          continue;
        }
        let profile = profileSnapshots.get(entry);
        if (!profile) {
          profile = policyProfile(entry, { groupId: group.id, entryId: entry.id });
          profileSnapshots.set(entry, profile);
        }
        entries.push(profile);
      }
      next = {
        ...source,
        name: group.name,
        entries,
        rejected,
        updatedAt: group.updatedAt,
        missing: false,
      };
      // Retain a bounded working set for several policies sharing one subscription.
      // Transient editor filters must not accumulate without limit.
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cache.set(key, next);
    }
    if (source === next) return source;
    changed = true;
    return next;
  });
  const manual = sources.manual.map((r) =>
    refreshPreparedReference(r, stash, depth + 1, scope, availability),
  );
  const fallback = sources.fallback
    ? refreshPreparedReference(sources.fallback, stash, depth + 1, scope, availability)
    : undefined;
  changed ||= manual.some((r, i) => r !== sources.manual[i]) || fallback !== sources.fallback;
  return changed
    ? { ...sources, manual, ...(fallback ? { fallback } : {}), subscriptions }
    : sources;
}

const refreshedReferences = new WeakMap<Stash, WeakMap<PolicyReference, PolicyReference>>();
export function refreshPreparedReference(
  ref: PolicyReference,
  stash: Stash,
  depth = 0,
  scope?: ReadonlySet<string>,
  availability?: ReadonlySet<string>,
): PolicyReference {
  if (ref.type !== 'profile') return ref;
  if (policyProfileId(ref.profile) !== ref.id)
    throw new Error('A saved policy profile has an inconsistent identity.');
  if (!availability && ref.source && (!scope || scope.has(ref.source.groupId))) {
    const entry = findStashEntry(stash, ref.source);
    if (entry?.profile && policyProfileId(entry.profile) !== ref.id)
      ref = policyProfile(entry, ref.source);
  }
  if (!['policy-group', 'proxy-chain'].includes(ref.profile.kind)) return ref;
  if (depth >= 16) throw new Error('Prepared outbounds exceed 16 nested levels.');
  let cache = scope ? undefined : refreshedReferences.get(stash);
  if (!scope && !cache) {
    cache = new WeakMap();
    refreshedReferences.set(stash, cache);
  }
  const cached = cache?.get(ref);
  if (cached) return cached;
  const data = {
    kind: ref.profile.kind,
    label: ref.name,
    description: '',
    settings: ref.profile.settings,
  };
  let settings = ref.profile.settings;
  if (ref.profile.kind === 'policy-group') {
    const sources = readPolicySources(data),
      next = refreshPolicySources(sources, stash, depth, scope, availability);
    if (next !== sources) {
      const json = JSON.stringify(next);
      if (json !== settings.sources) settings = { ...settings, sources: json };
      else sourceCache.set(data.settings, { json, value: next });
    }
  } else {
    const chain = readProxyChain(data),
      steps = chain.steps.map((s) => ({
        ...s,
        outbound: refreshPreparedReference(s.outbound, stash, depth + 1, scope, availability),
      }));
    if (steps.some((s, i) => s.outbound !== chain.steps[i].outbound))
      settings = { ...settings, steps: JSON.stringify({ ...chain, steps }) };
  }
  const profile = { ...ref.profile, settings };
  const next =
    settings === ref.profile.settings ? ref : { ...ref, profile, id: policyProfileId(profile) };
  cache?.set(ref, next);
  return next;
}
export function refreshStashComposites(stash: Stash): Stash {
  let changed = false;
  const groups = stash.groups.map((group) => {
    let groupChanged = false;
    const entries = group.entries.map((entry) => {
      if (
        entry.locked ||
        !entry.profile ||
        !['policy-group', 'proxy-chain'].includes(entry.profile.kind)
      )
        return entry;
      let before = compositeSnapshots.get(entry);
      if (!before) {
        before = policyProfile(entry);
        compositeSnapshots.set(entry, before);
      }
      const after = refreshPreparedReference(before, stash);
      if (after === before || after.type !== 'profile') return entry;
      groupChanged = changed = true;
      return {
        ...entry,
        profile: after.profile,
        ...(entry.draft ? { draft: { ...entry.draft, settings: after.profile.settings } } : {}),
      };
    });
    return groupChanged ? { ...group, entries } : group;
  });
  return changed ? { ...stash, groups } : stash;
}
export interface PolicyRefreshPatch {
  id: string;
  kind: RuleNodeData['kind'];
  field: 'sources' | 'steps';
  before: string;
  after: string;
}
let preparedRefreshes = new WeakMap<Stash, Map<string, PolicyRefreshPatch>>();
export function primePolicyRefresh(stash: Stash, patches: PolicyRefreshPatch[]): void {
  // Undo retains old Stash keys. Keep preparation for one current revision,
  // rather than retaining another pair of large source strings per undo entry.
  preparedRefreshes = new WeakMap([[stash, new Map(patches.map((p) => [p.id, p]))]]);
}
export function refreshPolicyGraph(
  graph: GraphState,
  stash: Stash,
  scope?: ReadonlySet<string>,
  availability?: ReadonlySet<string>,
): GraphState {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const patch = scope ? undefined : preparedRefreshes.get(stash)?.get(node.id);
    if (patch && patch.kind === node.data.kind) {
      const value = node.data.settings[patch.field];
      if (value === patch.after) return node;
      if (value === patch.before) {
        changed = true;
        return {
          ...node,
          data: { ...node.data, settings: { ...node.data.settings, [patch.field]: patch.after } },
        };
      }
    }
    if (node.data.kind === 'proxy-chain') {
      try {
        const chain = readProxyChain(node.data);
        const steps = chain.steps.map((s) => ({
          ...s,
          outbound: refreshPreparedReference(s.outbound, stash, 0, scope, availability),
        }));
        if (steps.every((s, i) => s.outbound === chain.steps[i].outbound)) return node;
        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            settings: { ...node.data.settings, steps: JSON.stringify({ ...chain, steps }) },
          },
        };
      } catch {
        return node;
      }
    }
    if (node.data.kind !== 'policy-group') return node;
    try {
      const sources = readPolicySources(node.data);
      const next = refreshPolicySources(sources, stash, 0, scope, availability);
      if (next === sources) return node;
      const json = JSON.stringify(next);
      if (json === node.data.settings.sources) {
        sourceCache.set(node.data.settings, { json, value: next });
        return node;
      }
      changed = true;
      const data = { ...node.data, settings: { ...node.data.settings, sources: json } };
      sourceCache.set(data.settings, { json, value: next });
      return { ...node, data };
    } catch {
      return node; /* Invalid drafts remain visible and diagnosed. */
    }
  });
  return changed ? { ...graph, nodes } : graph;
}

// Configuration identity still validates/deduplicates profiles. A linked
// entry's runtime identity survives endpoint/credential refreshes.
export function policyRuntimeId(reference: PolicyProfile): string {
  return reference.source
    ? stableProfileKey(JSON.stringify([reference.source.groupId, reference.source.entryId]))
    : reference.id;
}
export function resolvePolicyReference(
  graph: GraphState,
  reference: PolicyReference,
  nodes?: ReadonlyMap<string, RuleNode>,
): RuleNode {
  if (reference.type === 'node') {
    const node = nodes
      ? nodes.get(reference.nodeId)
      : allOutboundNodes(graph).find((n) => n.id === reference.nodeId);
    if (!node || !isOutboundKind(node.data.kind))
      throw new Error('A selected outbound is missing.');
    return node;
  }
  if (policyProfileId(reference.profile) !== reference.id)
    throw new Error('A saved policy profile has an inconsistent identity.');
  const node = makeNode(
    reference.profile.kind,
    { x: 0, y: 0 },
    `policy-profile-${policyRuntimeId(reference)}`,
  );
  node.data.label = reference.name;
  node.data.settings = validateSettings(node.data.kind, {
    ...node.data.settings,
    ...reference.profile.settings,
  });
  node.data.settings.tag = `wayrill-policy-profile-${policyRuntimeId(reference)}`;
  node.data.overrides = bindingsFor(node.data.kind)
    .filter((b) => Object.hasOwn(reference.profile.settings, b.nodeKey))
    .map((b) => b.nodeKey);
  node.data = resolveNodeData(node.data, graph.defaults);
  const problems = [
    ...outboundProblems(node.data)
      .filter((p) => p.severity === 'error')
      .map((p) => p.message),
    ...getDefinition(node.data.kind).fields.flatMap((field) => {
      const problem = fieldProblem(field, node.data.settings);
      return problem ? [`${field.label}: ${problem}`] : [];
    }),
  ];
  if (problems.length) throw new Error(`${reference.name}: ${problems.join(' ')}`);
  return node;
}
export function policyReferenceSet(
  graph: GraphState,
  group: RuleNode,
  sources = readPolicySources(group.data),
): { reference: PolicyReference; origin: string }[] {
  const mode = group.data.settings.selection;
  if (mode === 'prefixes') {
    const prefixes = String(group.data.settings.selectorPrefixes)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return allOutboundNodes(graph)
      .filter(
        (n) =>
          isOutboundKind(n.data.kind) &&
          n.data.kind !== 'policy-group' &&
          prefixes.some((p) => String(n.data.settings.tag ?? '').startsWith(p)),
      )
      .map((node) => ({
        reference: { type: 'node' as const, nodeId: node.id },
        origin: 'Native tag prefixes',
      }));
  }
  const candidates: { reference: PolicyReference; origin: string }[] = [];
  if (mode === 'manual' || mode === 'combined')
    candidates.push(...sources.manual.map((reference) => ({ reference, origin: 'Manual set' })));
  if (mode === 'subscription' || mode === 'combined')
    for (const source of sources.subscriptions)
      candidates.push(...source.entries.map((reference) => ({ reference, origin: source.name })));
  const unique = new Map<string, { reference: PolicyReference; origin: string }>();
  for (const item of candidates) {
    const key =
      item.reference.type === 'node'
        ? `node:${item.reference.nodeId}`
        : `profile:${item.reference.id}`;
    const existing = unique.get(key);
    if (
      existing?.reference.type === 'profile' &&
      item.reference.type === 'profile' &&
      policyProfileIdentity(existing.reference.profile) !==
        policyProfileIdentity(item.reference.profile)
    )
      throw new Error('Policy profile identity collision; the outbound set was not changed.');
    if (!existing) unique.set(key, item);
  }
  return [...unique.values()];
}
export function policyCandidates(graph: GraphState, group: RuleNode): PolicyCandidate[] {
  const references = policyReferenceSet(graph, group);
  if (references.length > LIMITS.maxOutbounds)
    throw new Error(
      `${group.data.label}: ${references.length} selected outbounds exceed the service limit of ${OUTBOUND_LIMIT_LABEL} outbounds; narrow the subscription filters. Generated and other graph outbounds also count toward this limit.`,
    );
  const nodes = new Map(allOutboundNodes(graph).map((n) => [n.id, n]));
  return references.map(({ reference, origin }) => {
    const node = resolvePolicyReference(graph, reference, nodes);
    return {
      node,
      reference,
      origin,
      weightTag:
        (group.data.preparedWeightTags && Object.hasOwn(group.data.preparedWeightTags, node.id)
          ? group.data.preparedWeightTags[node.id]
          : undefined) ??
        (reference.type === 'profile'
          ? String(reference.profile.settings.tag || reference.name)
          : String(node.data.settings.tag)),
    };
  });
}
const checkedProfiles = new WeakMap<
  PolicyProfile,
  { profile: string; id: string; name: string; defaults: string }
>();
export function policySourceProblems(
  graph: GraphState,
  group: RuleNode,
  sources = readPolicySources(group.data),
): Diagnostic[] {
  const issues: Diagnostic[] = [],
    mode = group.data.settings.selection;
  const add = (message: string, severity: Diagnostic['severity'] = 'error') =>
    issues.push({
      nodeId: group.id,
      fieldKey: 'sources',
      severity,
      message: `${group.data.label}: ${message}`,
    });
  if (mode === 'subscription' || mode === 'combined') {
    if (!sources.subscriptions.length) add('Choose a subscription group.');
    for (const s of sources.subscriptions) {
      if (s.missing)
        add(
          `${s.name} is absent from the stash; using its saved outbound snapshot. Relink or remove this source in Edit Group.`,
          'warning',
        );
      if (s.rejected)
        add(`${s.name}: ${s.rejected} matching unsupported entries are excluded.`, 'warning');
    }
  }
  try {
    const members = policyReferenceSet(graph, group, sources);
    if (!members.length && !group.data.settings.fallbackEnabled)
      add('No outbound matches this set; change its sources or configure a fallback.');
    if (members.length > LIMITS.maxOutbounds)
      add(
        `${members.length} selected outbounds exceed the service limit of ${OUTBOUND_LIMIT_LABEL}. Narrow the filters before running.`,
        'warning',
      );
    const nodes = new Map(allOutboundNodes(graph).map((n) => [n.id, n]));
    const defaults = JSON.stringify(graph.defaults);
    for (const { reference } of members) {
      if (reference.type === 'node') {
        resolvePolicyReference(graph, reference, nodes);
        continue;
      }
      if (members.length > LIMITS.maxOutbounds) continue;
      const profile = JSON.stringify(reference.profile),
        previous = checkedProfiles.get(reference);
      if (
        previous?.profile === profile &&
        previous.id === reference.id &&
        previous.name === reference.name &&
        previous.defaults === defaults
      )
        continue;
      resolvePolicyReference(graph, reference, nodes);
      checkedProfiles.set(reference, { profile, id: reference.id, name: reference.name, defaults });
    }
    if (group.data.settings.fallbackEnabled) {
      if (!sources.fallback) add('Choose a fallback outbound.');
      else resolvePolicyReference(graph, sources.fallback);
    }
  } catch (e) {
    add(e instanceof Error ? e.message : 'Invalid outbound set.');
  }
  return issues;
}

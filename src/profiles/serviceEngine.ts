// Fixed application code, bundled for the restricted subscription helper.
// No subscription can supply executable code or a module path.
import { parseStash, serializeStash, type Stash } from './import';
import { prepareRefresh, materializeRefresh } from './refreshPreparation';
import { parseGraph, serializeGraph } from '../graph/model';
import { refreshAppliedSubscriptions } from './subscriptionRuntime';
import { analyzeGraph } from '../graph/analysis';
import {
  effectivePoolApplications,
  type PoolApplicationChanges,
  type PoolApplicationDetection,
} from '../graph/applications';
import { graphPoolApplications } from '../graph/poolApplicationGraph';
import { jsonEqual } from '../graph/xrayJson';
import { createTestPlan, type TestSelection } from '../outboundTestPlan';
import { applySubscriptionHealth } from './subscriptionHealth';
import { refreshStashComposites } from '../graph/policySources';
import { policyProfileId } from '../graph/profileIdentity';
import { mergeStashDocuments } from './stashMerge';
import { defaultGroup, findStashEntry } from './stashModel';
import { applyStashedProfile } from './graph';
import type { GraphState, StashLink } from '../graph/types';
import type { HealthObservation } from './subscriptionState';
import { maintenanceDefaults, normalizeMaintenance, entryAvailable } from './subscriptionState';
import { protectedSubscriptionEntries } from './subscriptionReferences';
import { decodeStashGroups } from './stashEncoding';
import {
  inspectPoolEntries,
  poolRoutingState,
  preparePoolWorkspace,
  type PoolBindings,
  type PoolCapture,
} from '../pool/model';
import { resolvePoolDelivery, type PoolChoiceNames, type PoolSelection } from '../pool/delivery';
import {
  applyPoolPreferences,
  personalSettingChoices,
  poolPreferenceBase,
  type PoolPreferenceBase,
  type PoolPreferenceResets,
} from '../pool/preferences';
import { preparePublications, readPublication } from './subscriptionPublication';

interface Request {
  operation:
    | 'validate'
    | 'merge'
    | 'refresh'
    | 'health'
    | 'plan'
    | 'outboundTests'
    | 'runtime'
    | 'cycle'
    | 'poolPrepare'
    | 'poolRoutingState'
    | 'poolForgetStash'
    | 'poolReconcileStash'
    | 'poolInspect';
  bundle?: unknown;
  recipient?: string;
  capture?: PoolCapture;
  bindings?: PoolBindings;
  applicationChanges?: PoolApplicationChanges;
  detectedApplications?: PoolApplicationDetection;
  poolSelection?: PoolSelection;
  poolChoiceNames?: PoolChoiceNames;
  poolPreferenceBase?: PoolPreferenceBase;
  layeredRouting?: boolean;
  resetPreferences?: PoolPreferenceResets;
  reconcileBindings?: boolean;
  stash: string;
  base?: string;
  local?: string;
  graph?: string;
  appliedGraph?: string;
  groupId?: string;
  text?: string;
  observations?: HealthObservation[];
  removeDead?: boolean;
  entryIds?: string[];
  mode?: 'latency' | 'speed';
  nodeIds?: string[];
  entries?: StashLink[];
  selection?: TestSelection;
  cycleAt?: number | null;
  lastTestAt?: number;
  trusted?: boolean;
  groupSnapshot?: string;
  replacement?: StashLink & { nodeId: string };
  publications?: Record<string, string>;
}
const emptyGraph = (): GraphState => ({ name: 'Subscriptions', nodes: [], edges: [] });
export function subscriptionEngine(request: Request) {
  const graph = request.graph ? parseGraph(request.graph) : emptyGraph();
  const applied = request.appliedGraph ? parseGraph(request.appliedGraph) : undefined;
  if (request.operation === 'poolRoutingState') {
    const managedRoutingState = poolRoutingState(applied!, true);
    if (request.layeredRouting) return { poolRoutingState: managedRoutingState };
    // An older receipt contains only a digest. If its exact authenticated delivery
    // is still available, reconstruct the published values underneath local edits.
    let published = applied!;
    if (request.bundle) {
      const { bundle } = resolvePoolDelivery(request.bundle, request.poolSelection);
      published = preparePoolWorkspace(
        bundle,
        applied,
        { format: 'wayrill.stash', version: 3, groups: [] },
        request.recipient!,
        'current',
        request.bindings,
      ).graph;
    }
    return {
      poolRoutingState: poolRoutingState(applied!),
      managedRoutingState,
      matchesPublication:
        !!request.bundle && jsonEqual(poolRoutingState(published, true), managedRoutingState),
      poolPreferenceBase: poolPreferenceBase(published),
    };
  }
  if (request.operation === 'poolInspect') {
    const { bundle, selection, options } = resolvePoolDelivery(
      request.bundle,
      request.poolSelection,
      true,
      request.poolChoiceNames,
    );
    return {
      poolEntries: {
        ...inspectPoolEntries(
          bundle,
          applied,
          request.capture!,
          request.bindings,
          request.recipient,
        ),
        personalSettings: personalSettingChoices(
          applied?.poolId === request.recipient ? applied : undefined,
          request.poolPreferenceBase,
        ),
        selection,
        options,
      },
    };
  }
  let stash: Stash = request.stash
    ? request.trusted && !['validate', 'merge'].includes(request.operation)
      ? readValidatedStash(request.stash)
      : parseStash(request.stash)
    : { format: 'wayrill.stash', version: 3, groups: [defaultGroup()] };
  let summary: unknown;
  if (request.operation === 'poolForgetStash' || request.operation === 'poolReconcileStash') {
    const prefix = `pool-${request.recipient!}-`;
    const groups = stash.groups.filter((group) => !group.id.startsWith(prefix));
    if (request.operation === 'poolReconcileStash') {
      groups.push(
        ...readValidatedStash(request.local!).groups.filter((group) => group.id.startsWith(prefix)),
      );
    }
    const next = { ...stash, groups };
    return { stash: serializeStash(next), catalog: libraryCatalog(next) };
  }
  if (request.operation === 'poolPrepare') {
    const { bundle, selection, choiceNames, deviceSettings } = resolvePoolDelivery(
      request.bundle,
      request.poolSelection,
      false,
      request.poolChoiceNames,
    );
    const prepared = preparePoolWorkspace(
      bundle,
      applied,
      stash,
      request.recipient!,
      request.capture!,
      request.bindings,
      request.reconcileBindings,
      request.applicationChanges,
      request.detectedApplications,
    );
    const bindings = effectivePoolApplications(prepared.graph);
    const missing = graphPoolApplications(prepared.graph).find(
      ({ id, requireLocal }) => requireLocal && !bindings?.[id],
    );
    if (missing)
      throw new Error(
        `Choose “${missing.name}” in the Pool’s local application choices before applying this delivery.`,
      );
    const preferences = applyPoolPreferences(
      prepared.graph,
      applied?.poolId === request.recipient ? applied : undefined,
      request.poolPreferenceBase,
      request.resetPreferences,
    );
    const analysis = analyzeGraph(preferences.graph);
    const problem = analysis.issues.find((issue) => issue.severity === 'error');
    if (problem || !analysis.compilation)
      throw new Error(
        `Cannot apply “${prepared.name}”. ${problem?.message ?? 'Check the published routing paths.'} Review your choices or ask your Pool administrator to check the graph.`,
      );
    const preparedGraph = serializeGraph(preferences.graph);
    return {
      ...analysis.compilation,
      name: prepared.name,
      bindings: prepared.bindings,
      poolSelection: selection,
      poolChoiceNames: choiceNames,
      poolDeviceSettings: deviceSettings,
      poolRoutingState: poolRoutingState(parseGraph(preparedGraph), true),
      poolPreferenceBase: preferences.base,
      graph: preparedGraph,
      stash: serializeStash(prepared.stash),
      catalog: libraryCatalog(prepared.stash),
    };
  }
  const previous = stash;
  switch (request.operation) {
    case 'merge':
      stash = parseStash(
        mergeStashDocuments(
          request.base ?? serializeStash(stash),
          request.local!,
          serializeStash(stash),
        ),
      );
      break;
    case 'refresh': {
      const group = stash.groups.find((g) => g.id === request.groupId);
      if (!group) throw new Error('This subscription was removed.');
      const prepared = prepareRefresh({
        text: request.text!,
        name: group.name,
        stash,
        replaceId: group.id,
        graph: applied ?? graph,
        // Both the saved desktop draft and the applied graph protect references.
        protectedEntries: [...protectedSubscriptionEntries(stash, graph)],
      });
      stash = materializeRefresh(stash, prepared);
      summary = prepared.summary;
      break;
    }
    case 'health':
      stash = refreshStashComposites(
        applySubscriptionHealth(
          stash,
          { ...graph, nodes: [...graph.nodes, ...(applied?.nodes ?? [])] },
          request.groupId!,
          request.observations ?? [],
          !!request.removeDead,
        ),
      );
      break;
    case 'plan': {
      const ids = new Set(request.entryIds);
      const entries =
        stash.groups
          .find((g) => g.id === request.groupId)
          ?.entries.filter((entry) => ids.has(entry.id)) ?? [];
      const prepared = createTestPlan({ graph, stash, entries, mode: request.mode });
      return {
        plan: prepared.plan,
        targets: prepared.batch(prepared.plan.targets.map((t) => t.id)),
        identities: Object.fromEntries(
          entries.filter((e) => e.profile).map((e) => [e.id, policyProfileId(e.profile!)]),
        ),
      };
    }
    case 'outboundTests': {
      const entries = request.entries?.map((link) => {
        const entry = findStashEntry(stash, link);
        if (!entry) throw new Error('This Stash entry no longer exists.');
        return entry;
      });
      // A large Stash test can share the same DNS context and dialer outbounds
      // across thousands of probes. Send each fragment once to the coordinator.
      const fragments: unknown[] = [];
      const indices = new Map<string, number>();
      const shared = new WeakMap<object, number>();
      const intern = (value: unknown) => {
        const object = typeof value === 'object' && value !== null ? value : undefined;
        const previous = object && shared.get(object);
        if (previous !== undefined) return previous;
        const key = JSON.stringify(value);
        const index = indices.get(key) ?? fragments.push(value) - 1;
        indices.set(key, index);
        if (object) shared.set(object, index);
        return index;
      };
      const targets = new Map<
        string,
        { id: string; outboundTag: string; outbounds: number[]; fields: Record<string, number> }
      >();
      const prepared = createTestPlan(
        {
          graph,
          stash,
          entries,
          nodeIds: request.nodeIds,
          mode: request.mode,
          selection: request.selection,
        },
        ({ id, outboundTag, config }) => {
          const { outbounds, ...fields } = config;
          targets.set(id, {
            id,
            outboundTag,
            outbounds: (outbounds as unknown[]).map(intern),
            fields: Object.fromEntries(
              Object.entries(fields).map(([key, value]) => [key, intern(value)]),
            ),
          });
        },
      );
      return {
        plan: prepared.plan,
        preparedTargets: prepared.plan.targets.map(({ id }) => targets.get(id)!),
        fragments,
      };
    }
    case 'runtime': {
      if (!applied) return {};
      const selected = request.replacement && findStashEntry(stash, request.replacement);
      if (request.replacement && !selected)
        throw new Error('The selected Stash entry was removed. Choose another outbound.');
      if (selected && !entryAvailable(selected))
        throw new Error('This entry has no usable outbound configuration.');
      let availability: ReadonlySet<string> | undefined;
      if (request.groupSnapshot) {
        // The service persists the compact group at publication time. Later
        // library edits must not change an already approved background update.
        const snapshot = readPublication(request.groupSnapshot);
        if (snapshot.group.id !== request.groupId) throw new Error('Invalid provider publication.');
        if (snapshot.availability) availability = new Set(snapshot.availability);
        stash = {
          ...stash,
          groups: stash.groups.map((g) => (g.id === request.groupId ? snapshot.group : g)),
        };
      }
      let next = request.groupId
        ? refreshAppliedSubscriptions(applied, stash, new Set([request.groupId]), availability)
        : applied;
      if (request.replacement) {
        const { nodeId, ...link } = request.replacement;
        // Older approved provider work precedes the explicit saved choice.
        // A node added only to the desktop draft has no running instance yet.
        if (applied.nodes.some((node) => node.id === nodeId))
          next = applyStashedProfile(next, selected!, { x: 0, y: 0 }, nodeId, link);
      }
      const analysis = analyzeGraph(next);
      if (!analysis.compilation || analysis.issues.some((i) => i.severity === 'error'))
        throw new Error(
          'Updated subscription outbounds need attention; the running configuration was preserved.',
        );
      return { graph: serializeGraph(next), ...analysis.compilation };
    }
    case 'cycle':
      stash = {
        ...stash,
        groups: stash.groups.map((g) =>
          g.id !== request.groupId
            ? g
            : {
                ...g,
                testCycleAt: request.cycleAt ?? undefined,
                ...(request.lastTestAt === undefined ? {} : { lastTestAt: request.lastTestAt }),
              },
        ),
      };
      break;
    case 'validate':
      break;
    default:
      throw new Error('Unknown subscription operation.');
  }
  const previousGroups = new Map(previous.groups.map((g) => [g.id, g]));
  const changedGroups = stash.groups.filter(
    (g) =>
      g !== previousGroups.get(g.id) &&
      runtimeSignature(g) !== runtimeSignature(previousGroups.get(g.id)),
  );
  const changedIds = new Set(changedGroups.map((g) => g.id));
  const publications = preparePublications(
    previous,
    stash,
    changedIds,
    request.operation,
    request.groupId,
    request.publications,
  );
  return {
    stash: serializeStash(stash),
    // A library save is not an Apply. File refreshes publish a new source load;
    // availability changes publish only health for the same connection. Ordinary
    // graph/Stash field edits remain drafts until explicit activation.
    runtimeGroups: Object.keys(publications),
    publications,
    changedGroups: changedGroups.map((g) => g.id),
    summary,
    catalog: libraryCatalog(stash),
  };
}

function libraryCatalog(stash: Stash) {
  return stash.groups.map((g) => ({
    id: g.id,
    name: g.name,
    url: g.url,
    userAgent: g.userAgent,
    headers: g.headers,
    allowHttp: g.allowHttp,
    maintenance: g.maintenance ?? maintenanceDefaults,
    maintenancePaused: !!g.maintenancePaused,
    updatedAt: g.updatedAt,
    lastTestAt: g.lastTestAt ?? null,
    testCycleAt: g.testCycleAt ?? null,
    entries: g.entries.map((e) => ({
      id: e.id,
      kind: e.profile?.kind ?? null,
      retained: !!e.retained,
      checkedAt: e.health?.checkedAt ?? null,
    })),
  }));
}

function runtimeSignature(group: Stash['groups'][number] | undefined) {
  return (
    group &&
    JSON.stringify([
      group.name,
      group.entries.map((e) => [
        e.id,
        e.name,
        e.protocol,
        e.address,
        e.profile,
        e.draft,
        e.retained,
      ]),
    ])
  );
}

// Only service-owned, DPAPI-authenticated documents use this path. Imports and
// user edits still run full validation; internal health batches need not repeat
// every protocol field check for 50,000 unchanged profiles.
function readValidatedStash(text: string): Stash {
  const value = JSON.parse(text) as Omit<Stash, 'version'> & { version: number };
  if (value.version === 4) decodeStashGroups(value.groups);
  for (const group of value.groups)
    if (group.maintenance)
      group.maintenance = normalizeMaintenance(group.maintenance) as typeof group.maintenance;
  return { ...value, version: 3 };
}

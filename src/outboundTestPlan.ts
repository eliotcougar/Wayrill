import { isOutboundKind } from './graph/outbounds';
import { factoryDefaults, resolveNodeData } from './graph/defaults';
import { udpListenerEnvironment } from './graph/udpListeners';
import {
  policyCandidates,
  refreshPolicyGraph,
  resolvePolicyReference,
} from './graph/policySources';
import { compileDnsGraph } from './graph/dnsCompilation';
import { nativeConfig } from './graph/xrayNodes';
import { readProxyChain, observationSnapshot } from './graph/composites';
import { makeNode } from './graph/catalog';
import { preparedPreview } from './profiles/preparedPreview';
import { stashEditorNode } from './profiles/workspace';
import { entryLink, findStashEntry } from './profiles/stashModel';
import { xrayOutboundConfig } from './graph/xrayCompiler';
import { allOutboundNodes } from './graph/nativePool';
import type { GraphState, RuleNode, StashLink } from './graph/types';
import type { Stash, StashEntry } from './profiles/import';
import { stableProfileKey } from './graph/profileIdentity';

export interface TestRow {
  key: string;
  name: string;
  kind: string;
  targets: string[];
  strategy?: string;
  error?: string;
  hidden?: boolean;
}
export interface TestTarget {
  id: string;
  config: Record<string, unknown>;
  outboundTag: string;
}
export interface TestPlan {
  rows: TestRow[];
  targets: { id: string; name: string; origin?: TestOrigin }[];
}
export interface TestOrigin {
  key: string;
  mode: 'latency' | 'speed';
}
export type TestSelection = { key: string } | { id: string; origin: TestOrigin };
export function mergeTestPlans(previous: TestPlan | undefined, next: TestPlan): TestPlan {
  const rows = new Map(previous?.rows.map((row) => [row.key, row]));
  for (const row of next.rows) {
    const old = rows.get(row.key);
    rows.set(row.key, {
      ...row,
      hidden: !!row.hidden && (!old || !!old.hidden),
    });
  }
  const requested = new Set([...rows.values()].flatMap((row) => row.targets));
  const targets = new Map(previous?.targets.map((target) => [target.id, target]));
  for (const target of next.targets) targets.set(target.id, target);
  return {
    rows: [...rows.values()],
    targets: [...targets.values()].filter((target) => requested.has(target.id)),
  };
}
export const stashTestKey = (stash: Stash, entry: StashEntry) =>
  'stash:' + JSON.stringify(entryLink(stash, entry));
export interface TestPlanInput {
  graph: GraphState;
  stash: Stash;
  entries?: StashEntry[];
  nodeIds?: string[];
  mode?: 'latency' | 'speed';
  selection?: TestSelection;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Canonicalize local/generated tags without conflating different transport credentials or hops. */
export function testIdentity(config: Record<string, unknown>, tag: string): string {
  const tags = new Map<string, string>();
  const outputs = config.outbounds as Record<string, unknown>[];
  outputs.forEach((o, i) => tags.set(String(o.tag), `out-${i}`));
  const routing = record(config.routing) ? config.routing : {};
  if (Array.isArray(routing.balancers))
    routing.balancers.forEach((b, i) => {
      if (record(b)) tags.set(String(b.tag), `group-${i}`);
    });
  let reinjections = 0;
  for (const o of outputs)
    if (
      o.protocol === 'loopback' &&
      record(o.settings) &&
      typeof o.settings.inboundTag === 'string'
    )
      tags.set(o.settings.inboundTag, `hop-${reinjections++}`);
  const walk = (v: unknown, key = ''): unknown =>
    Array.isArray(v)
      ? v.map((x) => walk(x, key))
      : record(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, walk(v[k], k)]),
          )
        : typeof v === 'string' &&
            [
              'tag',
              'dialerProxy',
              'outboundTag',
              'balancerTag',
              'fallbackTag',
              'selector',
              'subjectSelector',
              'inboundTag',
            ].includes(key)
          ? (tags.get(v) ?? v)
          : v;
  return JSON.stringify({ config: walk(config), target: tags.get(tag) ?? tag });
}
export function createTestPlan(input: TestPlanInput) {
  const selection = input.selection;
  if (selection) {
    const key = 'key' in selection ? selection.key : selection.origin.key;
    if (key.startsWith('node:')) input = { ...input, nodeIds: [key.slice(5)] };
    else if (key.startsWith('stash:')) {
      const entry = findStashEntry(input.stash, JSON.parse(key.slice(6)) as StashLink);
      if (!entry) throw new Error('This Stash entry no longer exists.');
      input = { ...input, entries: [entry] };
    } else throw new Error('This outbound is no longer available.');
    // An individual member retains its original compilation semantics. A speed
    // retest of a group member must not silently become a test of the group winner.
    if ('id' in selection) input = { ...input, mode: selection.origin.mode };
  }
  const draft = {
    ...input.graph,
    edges: [...input.graph.edges],
    nodes: input.graph.nodes.map((n) => ({
      ...n,
      data: resolveNodeData(n.data, input.graph.defaults),
    })),
  };
  const roots: (TestRow & { node?: RuleNode })[] = [];
  const testTags = new Set(allOutboundNodes(draft).map((n) => String(n.data.settings.tag)));
  if (input.entries)
    input.entries.forEach((entry, i) => {
      const base = {
        key: stashTestKey(input.stash, entry),
        name: entry.name,
        kind: entry.profile?.kind ?? entry.draft?.kind ?? entry.protocol,
        targets: [],
      };
      if (base.kind === 'block-outbound') return;
      try {
        const node = stashEditorNode(entry, draft, `test-entry-${i}`);
        // Stash tags belong to independent definitions. They must not replace
        // graph dependencies or DNS transports when the test context is merged.
        let tag = `wayrill-test-entry-${i}`;
        while (testTags.has(tag)) tag += '-x';
        testTags.add(tag);
        node.data.settings.tag = tag;
        draft.nodes.push(node);
        if (['policy-group', 'proxy-chain'].includes(node.data.kind)) {
          const link = entryLink(input.stash, entry);
          const linked = draft.nodes.find(
            (n) =>
              n.data.stashLink?.groupId === link.groupId &&
              n.data.stashLink.entryId === link.entryId,
          );
          const connection =
            linked &&
            draft.edges.find((e) => e.source === linked.id && e.sourceHandle === 'observation');
          const snapshot = observationSnapshot(node.data);
          let observer =
            connection &&
            draft.nodes.find((n) => n.id === connection.target && n.data.kind === 'observatory');
          if (!observer && snapshot) {
            observer = makeNode('observatory', { x: 0, y: 0 }, `test-observer-${i}`);
            observer.data.settings = snapshot;
            draft.nodes.push(observer);
          }
          if (observer)
            draft.edges.push({
              id: `test-observation-${i}`,
              source: node.id,
              sourceHandle: 'observation',
              target: observer.id,
              targetHandle: 'in',
            });
        }
        roots.push({ ...base, node });
      } catch (e) {
        roots.push({
          ...base,
          error: e instanceof Error ? e.message : 'Invalid outbound.',
        });
      }
    });
  const refreshed = refreshPolicyGraph(draft, input.stash);
  const graph = {
    ...refreshed,
    nodes: refreshed.nodes.map((n) => ({
      ...n,
      data: resolveNodeData(n.data, draft.defaults),
    })),
  };
  if (!input.entries)
    graph.nodes
      .filter(
        (n) =>
          isOutboundKind(n.data.kind) &&
          n.data.kind !== 'block-outbound' &&
          (!input.nodeIds || input.nodeIds.includes(n.id)),
      )
      .forEach((node) =>
        roots.push({
          key: 'node:' + node.id,
          name: node.data.label,
          kind: node.data.kind,
          targets: [],
          node,
        }),
      );
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const linkedNodes = new Map<string, RuleNode[]>();
  for (const n of graph.nodes)
    if (n.data.stashLink) {
      const key = 'stash:' + JSON.stringify(n.data.stashLink);
      linkedNodes.set(key, [...(linkedNodes.get(key) ?? []), n]);
    }
  const hasDns = graph.nodes.some(
    (n) => n.data.kind === 'dns-handler' || n.data.kind === 'xray-dns',
  );
  let dns: ReturnType<typeof compileDnsGraph> | undefined;
  const options = graph.nodes.find((n) => n.data.kind === 'xray-options');
  const policy = options ? nativeConfig(options.data).policy : undefined;
  const targets = new Map<string, { node: RuleNode; name: string; origin: TestOrigin }>(),
    identities = new Map<string, string>();
  const rows: TestRow[] = [];
  const dependencies = new Map(
    allOutboundNodes(graph).map((n) => [String(n.data.settings.tag), n]),
  );
  // Only the DNS branch and its reusable definitions belong to DNS tests. Unrelated
  // canvas groups may contain thousands of candidates and must not be replicated.
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  function dnsContext(): GraphState {
    const keep = new Set<string>();
    const visit = (node: RuleNode) => {
      if (keep.has(node.id)) return;
      keep.add(node.id);
      for (const id of outgoing.get(node.id) ?? []) {
        const target = nodesById.get(id);
        if (target) visit(target);
      }
      if (node.data.kind === 'policy-group')
        for (const candidate of policyCandidates(graph, node)) visit(candidate.node);
      if (node.data.kind === 'proxy-chain')
        for (const step of readProxyChain(node.data).steps)
          visit(resolvePolicyReference(graph, step.outbound));
      if (
        isOutboundKind(node.data.kind) &&
        !['policy-group', 'proxy-chain'].includes(node.data.kind)
      ) {
        const value = xrayOutboundConfig(node.data);
        const stream = record(value.streamSettings) ? value.streamSettings : {};
        const sock = record(stream.sockopt) ? stream.sockopt : {};
        const proxy = record(value.proxySettings) ? value.proxySettings : {};
        const tag =
          typeof sock.dialerProxy === 'string'
            ? sock.dialerProxy
            : typeof proxy.tag === 'string'
              ? proxy.tag
              : '';
        const dependency = dependencies.get(tag);
        if (dependency) visit(dependency);
      }
    };
    for (const n of graph.nodes)
      if (['dns-handler', 'xray-dns', 'fakedns'].includes(n.data.kind)) visit(n);
    return {
      ...graph,
      nodes: graph.nodes.filter((n) => keep.has(n.id)),
      edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
      ...(graph.xray
        ? {
            xray: {
              ...graph.xray,
              outboundPool: graph.xray.outboundPool?.filter((n) => keep.has(n.id)),
            },
          }
        : {}),
    };
  }
  function configuration(node: RuleNode): TestTarget & { identity: string } {
    // Portable definitions include chains, nested groups, fragmentation and native settings.
    const context = nodesById.has(node.id) ? graph : { ...graph, nodes: [...graph.nodes, node] };
    const config: Record<string, unknown> =
      node.data.kind === 'proxy-chain' ||
      node.data.kind === 'policy-group' ||
      node.data.settings.finalFragmentEnabled
        ? preparedPreview(context, node).config
        : {
            outbounds: [xrayOutboundConfig(node.data)],
            routing: { rules: [], balancers: [] },
          };
    const outputs = config.outbounds as Record<string, unknown>[];
    let outboundTag = String(node.data.settings.tag);
    if (node.data.kind === 'policy-group') {
      // Xray balancers are routing targets, not outbound handlers. Give the
      // private HTTP listener one loopback handler that enters this balancer.
      const routing = config.routing as {
        rules: Record<string, unknown>[];
        balancers: Record<string, unknown>[];
      };
      const used = new Set([
        ...outputs.map((o) => String(o.tag)),
        ...routing.balancers.map((o) => String(o.tag)),
        ...routing.rules.flatMap((r) =>
          Array.isArray(r.inboundTag)
            ? r.inboundTag.filter((v: unknown): v is string => typeof v === 'string')
            : [],
        ),
      ]);
      let wrapper = 'wayrill-test-policy';
      for (let i = 1; used.has(wrapper) || used.has(`${wrapper}-route`); i++)
        wrapper = `wayrill-test-policy-${i}`;
      outputs.push({
        tag: wrapper,
        protocol: 'loopback',
        settings: { inboundTag: `${wrapper}-route` },
      });
      routing.rules.unshift({
        type: 'field',
        inboundTag: [`${wrapper}-route`],
        balancerTag: outboundTag,
      });
      outboundTag = wrapper;
    }
    const environment = udpListenerEnvironment(graph.defaults ?? factoryDefaults());
    if (Object.keys(environment).length) config.env = environment;
    if (policy) config.policy = policy;
    const known = new Set(outputs.map((o) => String(o.tag)));
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      const stream = record(o.streamSettings) ? o.streamSettings : {};
      const sock = record(stream.sockopt) ? stream.sockopt : {};
      const proxy = record(o.proxySettings) ? o.proxySettings : {};
      const tag =
        typeof sock.dialerProxy === 'string'
          ? sock.dialerProxy
          : typeof proxy.tag === 'string'
            ? proxy.tag
            : undefined;
      if (tag && !known.has(tag)) {
        const dependency = dependencies.get(tag);
        if (
          !dependency ||
          dependency.data.kind === 'policy-group' ||
          dependency.data.kind === 'proxy-chain'
        )
          throw new Error(`Missing test dependency: ${tag}.`);
        known.add(tag);
        outputs.push(xrayOutboundConfig(dependency.data));
      }
    }
    // The DNS/policy context is fixed for this plan. Fingerprint only the owned
    // outbound closure, rather than storing N copies of a possibly huge resolver set.
    const identity = testIdentity(config, outboundTag);
    // Keep the graph's DNS policy when resolving outbound destinations. Ordinary traffic rules are excluded.
    if (hasDns) {
      dns ??= compileDnsGraph(dnsContext());
      config.dns = dns.dns;
      if (dns.fakedns) config.fakedns = dns.fakedns;
      const existing = new Set(outputs.map((o) => o.tag));
      outputs.push(...dns.outbounds.filter((o) => !existing.has(o.tag)));
      const routing = config.routing as {
        rules: unknown[];
        balancers: unknown[];
      };
      routing.rules.push(...dns.routing.rules);
      for (const b of dns.routing.balancers ?? [])
        if (!routing.balancers.some((x) => record(x) && x.tag === b.tag)) routing.balancers.push(b);
      for (const key of ['observatory', 'burstObservatory'] as const)
        if (dns[key]) {
          const current = config[key],
            incoming = dns[key];
          if (record(current) && record(incoming)) {
            const { subjectSelector: oldSubjects, ...oldSettings } = current;
            const { subjectSelector: newSubjects, ...newSettings } = incoming;
            if (JSON.stringify(oldSettings) !== JSON.stringify(newSettings))
              throw new Error(
                'Outbound and DNS observation settings cannot be combined for this isolated test.',
              );
            config[key] = {
              ...oldSettings,
              subjectSelector: [
                ...new Set([
                  ...((Array.isArray(oldSubjects) ? oldSubjects : []) as unknown[]).filter(
                    (s): s is string => typeof s === 'string',
                  ),
                  ...((Array.isArray(newSubjects) ? newSubjects : []) as unknown[]).filter(
                    (s): s is string => typeof s === 'string',
                  ),
                ]),
              ],
            };
          } else config[key] = incoming;
        }
    }
    return { id: '', config, outboundTag, identity };
  }
  function collect(node: RuleNode, origin: TestOrigin, seen = new Set<string>()): string[] {
    if (node.data.kind === 'block-outbound') return [];
    if (seen.has(node.id) || seen.size >= 16)
      throw new Error('Outbound set contains a cycle or too many nested groups.');
    if (node.data.kind === 'policy-group' && input.mode !== 'speed') {
      const next = new Set(seen).add(node.id);
      return [
        ...new Set(policyCandidates(graph, node).flatMap((c) => collect(c.node, origin, next))),
      ];
    }
    const config = configuration(node);
    const root = (config.config.outbounds as Record<string, unknown>[]).find(
      (o) => o.tag === config.outboundTag,
    );
    if (
      !root ||
      ['blackhole', 'dns'].includes(String(root.protocol)) ||
      (root.protocol === 'loopback' && !['proxy-chain', 'policy-group'].includes(node.data.kind))
    )
      throw new Error('This outbound does not provide an independent HTTP connection.');
    const identity = config.identity;
    const existing = identities.get(identity);
    if (existing) {
      // Prefer a directly selected root over an indirect policy dependency.
      if (!seen.size) targets.get(existing)!.origin = origin;
      return [existing];
    }
    const id = `test-${stableProfileKey(identity)}`;
    if (targets.has(id)) throw new Error('Conflicting outbound test identities.');
    identities.set(identity, id);
    targets.set(id, { node, name: node.data.label, origin });
    return [id];
  }
  for (const row of roots) {
    if (!row.node) {
      rows.push(row);
      continue;
    }
    const node = nodesById.get(row.node.id)!;
    let result: TestRow;
    try {
      const ids = collect(node, { key: row.key, mode: input.mode ?? 'latency' });
      result = {
        key: row.key,
        name: row.name,
        kind: node.data.kind,
        targets: ids,
        strategy: String(node.data.settings.strategy ?? ''),
        ...(!ids.length ? { error: 'No outbound candidates.' } : {}),
      };
    } catch (error) {
      result = {
        key: row.key,
        name: row.name,
        kind: node.data.kind,
        targets: [],
        error: error instanceof Error ? error.message : 'Invalid outbound.',
      };
    }
    rows.push(result);
    if (node.data.stashLink)
      rows.push({
        ...result,
        key: 'stash:' + JSON.stringify(node.data.stashLink),
        hidden: true,
      });
    if (input.entries)
      for (const linked of linkedNodes.get(row.key) ?? [])
        rows.push({
          ...result,
          key: 'node:' + linked.id,
          name: linked.data.label,
          hidden: true,
        });
  }
  // A rejected group may have collected valid members before a later member failed.
  const requested = new Set(rows.flatMap((row) => row.targets));
  for (const id of targets.keys()) if (!requested.has(id)) targets.delete(id);
  let plan: TestPlan = {
    rows,
    targets: [...targets].map(([id, t]) => ({ id, name: t.name, origin: t.origin })),
  };
  if (selection && 'id' in selection) {
    const target = plan.targets.find((t) => t.id === selection.id);
    if (!target) throw new Error('This outbound changed. Run the group test again.');
    plan = {
      rows: [
        ...plan.rows.filter(
          (row) =>
            row.kind !== 'policy-group' && row.targets.length === 1 && row.targets[0] === target.id,
        ),
        {
          key: `target:${target.id}`,
          name: target.name,
          kind: 'outbound',
          targets: [target.id],
          hidden: true,
        },
      ],
      targets: [target],
    };
  }
  return {
    plan,
    batch: (ids: string[]) =>
      ids.map((id) => {
        const t = targets.get(id);
        if (!t) throw new Error('Unknown test target.');
        const target = configuration(t.node);
        return { id, config: target.config, outboundTag: target.outboundTag };
      }),
  };
}

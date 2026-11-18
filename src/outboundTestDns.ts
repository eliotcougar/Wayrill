import { nativeKey, nativeValue } from '@wayrill/core/nativeProperties';
import { outboundReferences } from '@wayrill/core/outboundReferences';
import { prefixMatches } from '@wayrill/core/prefixSelectors';
import { jsonEqual, jsonRecord, xrayStringList } from '@wayrill/core/xrayJson';
import type { DnsFragment } from './graph/dns';
import { compileXrayGraph } from './graph/xrayCompiler';
import { nativeResolverUsesRouter } from './graph/addressValidation';
import { compactSelectors } from './graph/prefixSelectors';
import type { GraphState } from './graph/types';

type ObjectMap = Record<string, unknown>;
export type TestDns = Omit<DnsFragment, 'dns'> & {
  dns: ObjectMap;
  defaultOutbound?: ObjectMap;
};
const records = (value: unknown): ObjectMap[] =>
  Array.isArray(value) ? value.filter(jsonRecord) : [];
const strings = (value: unknown) =>
  xrayStringList(value).filter((s): s is string => typeof s === 'string');

/** Native resolvers dispatch into the imported router. Keep the routes they can
 * enter in their original order, including another dispatch through loopback. */
export function nativeTestDns(graph: GraphState): TestDns {
  const { config } = compileXrayGraph(graph);
  const dns = config.dns;
  if (!jsonRecord(dns)) throw new Error('The imported DNS configuration is missing.');
  const result: TestDns = { dns, fakedns: config.fakedns, outbounds: [], routing: { rules: [] } };
  const servers = nativeValue(dns, 'servers');
  const routed = Array.isArray(servers) ? servers.filter(nativeResolverUsesRouter) : [];
  if (!routed.length) return result;

  const outputs = records(config.outbounds);
  if (!outputs.length) throw new Error('Imported DNS queries need a default outbound.');
  const routing = jsonRecord(config.routing) ? config.routing : {};
  const { rules: allRules, balancers: allBalancers, ...routingOptions } = routing;
  const rules = records(allRules),
    balancers = records(allBalancers);
  const byTag = new Map(outputs.filter((o) => o.tag).map((o) => [o.tag, o]));
  const byBalancer = new Map(balancers.filter((b) => b.tag).map((b) => [b.tag, b]));
  const rulesByInput = new Map<string, ObjectMap[]>();
  const selectedRules = new Set<ObjectMap>(),
    selectedBalancers = new Set<ObjectMap>();
  const selectedOutputs = new Set<ObjectMap>();
  const includeOutput = (o?: ObjectMap) => {
    if (o) selectedOutputs.add(o);
  };
  const includeRule = (rule: ObjectMap) => {
    if (selectedRules.has(rule)) return;
    selectedRules.add(rule);
    includeOutput(byTag.get(nativeValue(rule, 'outboundTag')));
    const group = byBalancer.get(nativeValue(rule, 'balancerTag'));
    if (!group || selectedBalancers.has(group)) return;
    selectedBalancers.add(group);
    const prefixes = strings(nativeValue(group, 'selector'));
    for (const o of outputs) {
      const tag = o.tag;
      if (typeof tag === 'string' && prefixes.some((p) => tag.startsWith(p))) includeOutput(o);
    }
    includeOutput(byTag.get(nativeValue(group, 'fallbackTag')));
  };
  for (const rule of rules) {
    const inputs = strings(nativeValue(rule, 'inboundTag'));
    if (!inputs.length) includeRule(rule);
    for (const tag of inputs) {
      const list = rulesByInput.get(tag);
      if (list) list.push(rule);
      else rulesByInput.set(tag, [rule]);
    }
  }
  const includeInput = (tag: unknown) => {
    if (typeof tag === 'string') rulesByInput.get(tag)?.forEach(includeRule);
  };
  for (const s of routed)
    includeInput((jsonRecord(s) && nativeValue(s, 'tag')) || nativeValue(dns, 'tag'));
  // Xray sends unmatched DNS traffic through the first outbound. A Set iterator
  // visits newly added handlers, so long dial-through paths need no recursion.
  result.defaultOutbound = outputs[0];
  includeOutput(result.defaultOutbound);
  for (const o of selectedOutputs)
    for (const ref of outboundReferences(o))
      if (ref.namespace === 'outbound') includeOutput(byTag.get(ref.tag));
      else includeInput(ref.tag);
  result.outbounds = outputs.filter((o) => selectedOutputs.has(o));
  result.routing = {
    ...routingOptions,
    rules: rules.filter((r) => selectedRules.has(r)),
    balancers: balancers.filter((b) => selectedBalancers.has(b)),
  };
  if (selectedBalancers.size) {
    result.observatory = config.observatory;
    result.burstObservatory = config.burstObservatory;
  }
  return result;
}

/** Joining two valid fragments can broaden a prefix selector in either direction. */
function keepMembers(definition: ObjectMap, field: string, own: string[], added: string[]) {
  if (!added.length) return definition;
  const key = nativeKey(definition, field);
  const prefixes = strings(definition[key]);
  if (!prefixes.some((p) => prefixMatches(added, p))) return definition;
  const selected = own.filter((tag) => prefixes.some((p) => tag.startsWith(p)));
  const all = [...own, ...added];
  const selectors = compactSelectors(selected, all);
  if (!selectors.length && field === 'selector') {
    // A fallback-only balancer requires a nonempty selector that matches nothing.
    let unused = 'wpe-empty';
    while (all.some((tag) => tag.startsWith(unused))) unused += '-';
    selectors.push(unused);
  }
  return { ...definition, [key]: selectors };
}

export function mergeTestDns(config: ObjectMap, dns: TestDns): void {
  config.dns = dns.dns;
  if (dns.fakedns) config.fakedns = dns.fakedns;
  const outputs = config.outbounds as ObjectMap[];
  const probe = new Map(outputs.map((o) => [o.tag, o]));
  const resolver = new Map(dns.outbounds.map((o) => [o.tag, o]));
  for (const o of dns.outbounds) {
    const existing = probe.get(o.tag);
    if (!existing) outputs.push(o);
    else if (!jsonEqual(existing, o))
      throw new Error(`Outbound and DNS paths use different settings for ${String(o.tag)}.`);
  }
  const { defaultOutbound } = dns;
  if (defaultOutbound) {
    const first = outputs.findIndex((o) => o.tag === defaultOutbound.tag);
    if (first > 0) outputs.unshift(...outputs.splice(first, 1));
  }
  const tags = (handlers: Map<unknown, ObjectMap>) =>
    [...handlers.keys()].filter((tag): tag is string => typeof tag === 'string' && !!tag);
  const probeTags = tags(probe),
    dnsTags = tags(resolver);
  const addedToProbe = dnsTags.filter((tag) => !probe.has(tag)).sort();
  const addedToDns = probeTags.filter((tag) => !resolver.has(tag)).sort();
  const routing = config.routing as { rules: ObjectMap[]; balancers: ObjectMap[] };
  const { rules, balancers, ...options } = dns.routing;
  Object.assign(routing, options);
  routing.rules.push(...rules);
  routing.balancers = routing.balancers.map((b) =>
    keepMembers(b, 'selector', probeTags, addedToProbe),
  );
  for (const b of balancers ?? []) {
    const scoped = keepMembers(b, 'selector', dnsTags, addedToDns);
    const existing = routing.balancers.find((group) => group.tag === b.tag);
    if (!existing) routing.balancers.push(scoped);
    else if (!jsonEqual(existing, scoped))
      throw new Error(
        `Outbound and DNS paths use different settings for policy group ${String(b.tag)}.`,
      );
  }
  for (const key of ['observatory', 'burstObservatory'] as const) {
    const left = config[key],
      right = dns[key];
    const current =
      jsonRecord(left) && keepMembers(left, 'subjectSelector', probeTags, addedToProbe);
    const incoming =
      jsonRecord(right) && keepMembers(right, 'subjectSelector', dnsTags, addedToDns);
    if (current && incoming) {
      const { subjectSelector: a, ...settings } = current;
      const { subjectSelector: b, ...other } = incoming;
      if (!jsonEqual(settings, other))
        throw new Error(
          'Outbound and DNS observation settings cannot be combined for this isolated test.',
        );
      config[key] = { ...settings, subjectSelector: [...new Set([...strings(a), ...strings(b)])] };
    } else if (current || incoming) config[key] = current || incoming;
  }
  if (config.observatory && config.burstObservatory)
    throw new Error('Outbound and DNS routes require different observation providers.');
}

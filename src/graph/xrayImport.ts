import { boundedText } from '../text';
import { parseGraph, serializeGraph } from './model';
import { LIMITS } from '../limits';
import { makeNode, getOutputPorts } from './catalog';
import { bindingsFor, factoryDefaults } from './defaults';
import { outboundBundle } from './outbounds';
import { xrayOutbound } from '../profiles/import';
import { importProxyInbound, projectProxyInbound } from './xrayInbound';
import { hydrateCoreDefaults } from './nativeCore';
import {
  tableSettings,
  routingConditionFields,
  routingRuleFields,
  effectiveRoutingFields,
  type NamedOutput,
  type TableRule,
} from './rules';
import { strategies } from './policies';
import { isFakeDnsAddress } from './fakeDns';
import { emptyPolicySources } from './policySources';
import { nativeConfig } from './xrayNodes';
import { cloneJson, jsonEqual, jsonRecord, parseXrayJson, jsonText, jsonArray } from './xrayJson';
import { coreProjection } from './xrayProjection';
import {
  compileXrayGraph,
  projectBalancer,
  projectObserver,
  syncXrayConnections,
} from './xrayCompiler';
import type { GraphState, RuleNode, RuleNodeData } from './types';
import {
  hydrateProtocolCommon,
  isProtocolInbound,
  isProtocolOutbound,
  protocolPreview,
  specForProtocol,
} from './protocols';

const field = (o: Record<string, unknown>, k: string) =>
  o[Object.keys(o).find((key) => key.toLowerCase() === k.toLowerCase()) ?? k];
const rest = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(
    Object.entries(o).filter(([k]) => !keys.some((key) => key.toLowerCase() === k.toLowerCase())),
  );
const lines = (v: unknown) =>
  jsonArray(v) ? v.map(String).join('\n') : typeof v === 'string' ? v : '';
const text = (v: unknown) => (v === undefined ? '' : jsonText(v));
const extra = (v: Record<string, unknown>) => (Object.keys(v).length ? JSON.stringify(v) : '');
const list = (o: Record<string, unknown>, key: string, max: number) => {
  const value = o[key];
  if (value === undefined) return [];
  if (!jsonArray(value) || value.length > max)
    throw new Error(`Use at most ${max} ${key} entries.`);
  return value;
};
function attach(
  node: RuleNode,
  original: Record<string, unknown>,
  projection: Record<string, unknown>,
) {
  node.data.native = {
    version: 1,
    original: cloneJson(original),
    projection: cloneJson(projection),
  };
}
function rawNode(
  kind: 'xray-inbound' | 'xray-outbound',
  original: Record<string, unknown>,
  position: { x: number; y: number },
  id: string,
): RuleNode {
  const node = makeNode(kind, position, id);
  node.data.settings = {
    tag: text(field(original, 'tag')),
    json: JSON.stringify(rest(original, ['tag']), null, 2),
  };
  node.data.label = boundedText(
    text(field(original, 'tag')) ||
      `${text(original.protocol) || 'Xray'} ${kind === 'xray-inbound' ? 'inbound' : 'outbound'}`,
    128,
  );
  attach(node, original, nativeConfig(node.data));
  return node;
}
function protocolNode(
  raw: Record<string, unknown>,
  direction: 'inbound' | 'outbound',
  position: { x: number; y: number },
  id: string,
): RuleNode | undefined {
  const spec = specForProtocol(field(raw, 'protocol'), direction);
  if (!spec || !(isProtocolInbound(spec.kind) || isProtocolOutbound(spec.kind))) return undefined;
  const node = makeNode(spec.kind, position, id);
  node.data.settings = hydrateProtocolCommon(raw, node.data.settings, direction);
  node.data.settings.tag = text(field(raw, 'tag'));
  node.data.settings.json = JSON.stringify(rest(raw, ['tag']), null, 2);
  node.data.overrides = bindingsFor(spec.kind).map((b) => b.nodeKey);
  node.data.settings.commonBaseline = JSON.stringify(
    Object.fromEntries(node.data.overrides.map((k) => [k, node.data.settings[k]])),
  );
  node.data.label = boundedText(node.data.settings.tag || `${spec.title} ${direction}`, 128);
  attach(node, raw, protocolPreview(node.data));
  node.data.native!.overrideKeys = [...node.data.overrides];
  return node;
}
export function importXrayConfig(
  textInput: string,
  name = 'Imported Xray configuration',
): GraphState {
  const value = parseXrayJson(textInput);
  if (!jsonRecord(value)) throw new Error('Supply a complete Xray JSON object.');
  // Native root spelling is unambiguous. Reject section aliases rather than
  // accidentally splitting two spellings between nodes and preserved options.
  for (const key of [
    'inbounds',
    'outbounds',
    'routing',
    'dns',
    'observatory',
    'burstObservatory',
  ]) {
    const aliases = Object.keys(value).filter((k) => k.toLowerCase() === key.toLowerCase());
    if (aliases.length > 1 || (aliases.length === 1 && aliases[0] !== key))
      throw new Error(`Use the canonical root section name ${key}.`);
  }
  if (value.observatory !== undefined && value.burstObservatory !== undefined)
    throw new Error('Use one Xray observation provider.');
  const routing = value.routing === undefined ? {} : value.routing;
  if (!jsonRecord(routing)) throw new Error('routing must be an object.');
  const inputs = list(value, 'inbounds', 16),
    outputs = list(value, 'outbounds', LIMITS.maxOutbounds),
    balancers = list(routing, 'balancers', 64),
    rules = list(routing, 'rules', LIMITS.maxRoutingRules);
  const graph: GraphState = {
    name: boundedText(name, 128),
    defaults: factoryDefaults(),
    nodes: [],
    edges: [],
  };
  const options = makeNode('xray-options', { x: 20, y: -250 }, 'native-options');
  const root = rest(value, [
    'inbounds',
    'outbounds',
    'routing',
    'dns',
    'observatory',
    'burstObservatory',
  ]);
  delete root.fakedns;
  if (value.routing !== undefined) root.routing = rest(routing, ['rules', 'balancers']);
  options.data.settings.json = JSON.stringify(root, null, 2);
  graph.nodes.push(options);
  graph.defaults = hydrateCoreDefaults(value, graph.defaults);
  const filter = makeNode('routing-filter', { x: 350, y: 70 }, 'native-routing');
  filter.data.label = 'Global routing rules';
  graph.nodes.push(filter);
  const inboundOrder: string[] = [],
    outboundOrder: string[] = [],
    balancerOrder: string[] = [];
  const connect = (source: RuleNode, port: string, target: RuleNode) =>
    graph.edges.push({
      id: crypto.randomUUID(),
      source: source.id,
      sourceHandle: port,
      target: target.id,
      targetHandle: 'in',
    });
  for (const [i, raw] of inputs.entries()) {
    if (!jsonRecord(raw)) throw new Error('Every inbound must be an object.');
    let node: RuleNode;
    const protocol = protocolNode(raw, 'inbound', { x: 20, y: i * 240 }, `native-in-${i}`);
    if (protocol) node = protocol;
    else
      try {
        const settings = importProxyInbound(raw);
        node = makeNode('proxy-inbound', { x: 20, y: i * 240 }, `native-in-${i}`);
        node.data.settings = settings;
        node.data.overrides = bindingsFor('proxy-inbound').map((b) => b.nodeKey);
        node.data.label = boundedText(text(raw.tag), 128);
        // Preserve the source users/accounts alias when it is changed later.
        node.data.native = {
          version: 1,
          original: cloneJson(raw),
          projection: {},
          overrideKeys: [...node.data.overrides],
        };
        node.data.native.projection = projectProxyInbound(node.data);
      } catch {
        node = rawNode('xray-inbound', raw, { x: 20, y: i * 240 }, `native-in-${i}`);
      }
    graph.nodes.push(node);
    inboundOrder.push(node.id);
    for (const port of getOutputPorts(node.data.kind, node.data)) connect(node, port, filter);
  }
  const outboundPool: { id: string; config: Record<string, unknown> }[] = [];
  const explicitTags = new Set([
    ...rules.flatMap((r) =>
      jsonRecord(r) && typeof r.outboundTag === 'string' ? [r.outboundTag] : [],
    ),
    ...balancers.flatMap((b) =>
      jsonRecord(b) && typeof b.fallbackTag === 'string' ? [b.fallbackTag] : [],
    ),
  ]);
  let visibleOutbounds = 0;
  for (const [i, raw] of outputs.entries()) {
    if (outputs.length > 256 && i > 0 && jsonRecord(raw) && !explicitTags.has(String(raw.tag))) {
      const id = `native-out-${i}`;
      outboundPool.push({ id, config: cloneJson(raw) });
      outboundOrder.push(id);
      continue;
    }
    if (!jsonRecord(raw)) throw new Error('Every outbound must be an object.');
    let node: RuleNode;
    // Pooled entries have no canvas card. Layout only materialized candidates,
    // and wrap long columns so every imported position remains reloadable.
    const position = {
      x: 1080 + Math.floor(visibleOutbounds / 64) * 400,
      y: (visibleOutbounds % 64) * 205,
    };
    visibleOutbounds++;
    const protocol = protocolNode(raw, 'outbound', position, `native-out-${i}`);
    if (protocol) node = protocol;
    else
      try {
        if (typeof raw.tag !== 'string' || !raw.tag)
          throw new Error('Untagged outbounds use native JSON.');
        if (
          raw.protocol === 'socks' &&
          jsonRecord(raw.settings) &&
          raw.settings.servers !== undefined
        )
          throw new Error('Legacy SOCKS layout uses native JSON.');
        if (jsonRecord(raw.settings) && raw.settings.vnext !== undefined)
          throw new Error('Legacy VLESS layout uses native JSON.');
        if (
          jsonRecord(raw.streamSettings) &&
          ['tcp', 'splithttp'].includes(String(raw.streamSettings.network))
        )
          throw new Error('Legacy transport aliases use native JSON.');
        const profile = xrayOutbound(raw);
        node = makeNode(profile.kind, position, `native-out-${i}`);
        node.data.settings = { ...node.data.settings, ...profile.settings, tag: text(raw.tag) };
        node.data.overrides = bindingsFor(node.data.kind).map((b) => b.nodeKey);
        node.data.label = boundedText(
          text(raw.tag) || `${jsonText(raw.protocol)} outbound ${i + 1}`,
          128,
        );
        const bundle = outboundBundle(node.data);
        if (bundle.length !== 1)
          throw new Error('Native fragment destinations are preserved independently.');
        const projection = { ...bundle[0] };
        if (!node.data.settings.tag) delete projection.tag;
        attach(node, raw, projection);
        node.data.native!.overrideKeys = [...node.data.overrides];
      } catch {
        node = rawNode('xray-outbound', raw, position, `native-out-${i}`);
      }
    graph.nodes.push(node);
    outboundOrder.push(node.id);
  }
  const observerKey = value.burstObservatory !== undefined ? 'burstObservatory' : 'observatory';
  let observer: RuleNode | undefined;
  if (value[observerKey] !== undefined) {
    const raw = value[observerKey];
    if (!jsonRecord(raw)) throw new Error('Observation settings must be an object.');
    const subjects = field(raw, 'subjectSelector');
    if (
      subjects !== undefined &&
      (!jsonArray(subjects) ||
        subjects.some((p) => typeof p !== 'string' || !p || p.trim() !== p || /[\r\n]/.test(p)))
    )
      throw new Error(
        'Observation prefixes must be nonempty single-line tags without surrounding whitespace.',
      );
    observer = makeNode('observatory', { x: 710, y: -270 }, 'native-observatory');
    const s = observer.data.settings;
    s.mode = observerKey === 'burstObservatory' ? 'burst' : 'standard';
    s.subjects = 'prefixes';
    s.selectorPrefixes = lines(field(raw, 'subjectSelector'));
    for (const key of ['probeURL', 'probeInterval', 'enableConcurrency'])
      if (field(raw, key) !== undefined)
        s[key] = field(raw, key) as RuleNodeData['settings'][string];
    const ping = field(raw, 'pingConfig');
    if (jsonRecord(ping)) {
      for (const key of [
        'destination',
        'connectivity',
        'interval',
        'sampling',
        'timeout',
        'httpMethod',
      ])
        if (field(ping, key) !== undefined)
          s[key] = field(ping, key) as RuleNodeData['settings'][string];
      s.healthExtra = extra(
        rest(ping, [
          'destination',
          'connectivity',
          'interval',
          'sampling',
          'timeout',
          'httpMethod',
        ]),
      );
    }
    s.extra = extra(
      rest(raw, [
        'subjectSelector',
        'probeURL',
        'probeInterval',
        'enableConcurrency',
        'pingConfig',
      ]),
    );
    attach(observer, raw, projectObserver(observer.data, []));
    graph.nodes.push(observer);
  }
  for (const [i, raw] of balancers.entries()) {
    if (
      !jsonRecord(raw) ||
      !jsonArray(raw.selector) ||
      raw.selector.some((p) => typeof p !== 'string' || !p || p.trim() !== p || /[\r\n]/.test(p))
    )
      throw new Error(
        'Balancer selectors must be nonempty single-line tag-prefix arrays without surrounding whitespace.',
      );
    const node = makeNode('policy-group', { x: 720, y: i * 290 }, `native-balancer-${i}`),
      s = node.data.settings;
    const strategy = jsonRecord(raw.strategy) ? raw.strategy : {},
      settings = jsonRecord(strategy.settings) ? strategy.settings : {};
    const type = strategies.find(
      (v) => v.toLowerCase() === jsonText(strategy.type ?? 'random').toLowerCase(),
    );
    if (!type) throw new Error('This balancer strategy has no supported policy-group editor.');
    s.tag = text(raw.tag);
    s.strategy = type;
    s.selection = 'prefixes';
    s.selectorPrefixes = lines(raw.selector);
    const sources = emptyPolicySources();
    s.fallbackEnabled = !!raw.fallbackTag;
    s.observe = !!observer;
    for (const k of ['expected', 'maxRTT', 'tolerance'])
      if (settings[k] !== undefined)
        s[k] =
          k === 'tolerance'
            ? jsonText(settings[k])
            : (settings[k] as RuleNodeData['settings'][string]);
    if (settings.baselines !== undefined) s.baselines = lines(settings.baselines);
    if (settings.costs !== undefined) s.costs = JSON.stringify(settings.costs);
    s.strategyExtra = extra(
      rest(settings, ['expected', 'maxRTT', 'tolerance', 'baselines', 'costs']),
    );
    s.extra = extra(rest(raw, ['tag', 'selector', 'strategy', 'fallbackTag']));
    node.data.label = boundedText(s.tag || `Policy group ${i + 1}`, 128);
    graph.nodes.push(node);
    balancerOrder.push(node.id);
    if (raw.fallbackTag) {
      const fallback = graph.nodes.find(
        (n) => outboundOrder.includes(n.id) && n.data.settings.tag === raw.fallbackTag,
      );
      if (!fallback) throw new Error('A balancer fallback references a missing outbound.');
      sources.fallback = { type: 'node', nodeId: fallback.id };
    }
    s.sources = JSON.stringify(sources);
    if (observer) connect(node, 'observation', observer);
    attach(
      node,
      raw,
      projectBalancer(
        node.data,
        raw.selector as string[],
        raw.fallbackTag === undefined ? undefined : jsonText(raw.fallbackTag),
      ),
    );
  }
  const api = jsonRecord(value.api) ? value.api : undefined;
  const named: NamedOutput[] = [],
    ports = new Map<string, string>();
  function targetPort(type: 'outboundTag' | 'balancerTag', tag: string): string {
    const id = `${type}:${tag}`;
    if (ports.has(id)) return ports.get(id)!;
    const order = type === 'outboundTag' ? outboundOrder : balancerOrder,
      target = graph.nodes.find((n) => order.includes(n.id) && n.data.settings.tag === tag);
    if (!target) {
      if (type === 'outboundTag' && api?.tag === tag)
        throw new Error('Routing to the Xray API virtual outbound is not supported in graphs.');
      throw new Error('A routing rule references a missing destination.');
    }
    const port = `route-${named.length}`;
    named.push({ id: port, name: (tag || 'Default outbound').slice(0, 64) });
    ports.set(id, port);
    connect(filter, port, target);
    return port;
  }
  const rows: TableRule[] = rules.map((raw, i) => {
    if (!jsonRecord(raw)) throw new Error('Every routing rule must be an object.');
    const type =
      typeof raw.balancerTag === 'string' && raw.balancerTag ? 'balancerTag' : 'outboundTag';
    if (raw.outboundTag && raw.balancerTag)
      throw new Error('A rule with both destination types must be resolved before visual import.');
    if (typeof raw[type] !== 'string' || !raw[type])
      throw new Error('Every routing rule needs an outboundTag or balancerTag.');
    const conditions: Record<string, string> = {};
    const effective = effectiveRoutingFields(raw);
    for (const f of routingConditionFields)
      if (effective[f.key] !== undefined)
        conditions[f.key] = f.list
          ? lines(effective[f.key])
          : f.key === 'attrs'
            ? JSON.stringify(effective[f.key])
            : String(effective[f.key]);
    const row: TableRule = {
      id: `native-rule-${i}`,
      name: `Rule ${i + 1}`,
      enabled: true,
      output: targetPort(type, String(raw[type])),
      conditions,
      targetMatch: 'all',
      matchAll: !Object.values(conditions).some((v) => v.trim()),
      native: { version: 1, original: cloneJson(raw), projection: {} },
    };
    row.native!.projection = routingRuleFields(row);
    return row;
  });
  const first = graph.nodes.find((n) => n.id === outboundOrder[0]);
  let defaultOutput = 'native-default';
  if (first) defaultOutput = targetPort('outboundTag', String(first.data.settings.tag));
  else named.push({ id: defaultOutput, name: 'No default outbound' });
  // Different namespaces may legally share a tag. Keep display names unique.
  const names = new Set<string>();
  for (const o of named) {
    const base = o.name;
    let i = 2;
    while (names.has(o.name.toLowerCase())) o.name = `${base.slice(0, 58)} (${i++})`;
    names.add(o.name.toLowerCase());
  }
  filter.data.settings = tableSettings({ outputs: named, rules: rows, defaultOutput });
  let dnsNodeId: string | undefined;
  if (value.dns !== undefined) {
    if (!jsonRecord(value.dns)) throw new Error('dns must be an object.');
    const dns = makeNode(
      'xray-dns',
      { x: 20, y: Math.max(500, inputs.length * 240 + 140) },
      'native-dns',
    );
    dnsNodeId = dns.id;
    dns.data.settings.json = JSON.stringify(rest(value.dns, ['servers']), null, 2);
    const servers = list(value.dns, 'servers', 128),
      ordered: NamedOutput[] = [];
    for (const [i, server] of servers.entries()) {
      const node = makeNode(
        isFakeDnsAddress(jsonRecord(server) ? field(server, 'address') : server)
          ? 'fakedns'
          : 'xray-dns-servers',
        {
          x: 350 + Math.floor(i / 64) * 400,
          y: Math.max(600, Math.min(visibleOutbounds, 64) * 205) + (i % 64) * 230,
        },
        `native-resolver-${i}`,
      );
      node.data.label = `DNS server ${i + 1}`;
      if (node.data.kind === 'fakedns') {
        node.data.label = `FakeDNS ${i + 1}`;
        node.data.settings = {
          pools: value.fakedns === undefined ? '' : JSON.stringify(value.fakedns),
          servers: JSON.stringify([server]),
        };
      } else node.data.settings.json = JSON.stringify({ servers: [server] }, null, 2);
      graph.nodes.push(node);
      const port = `resolver-${i}`;
      ordered.push({ id: port, name: `Server ${i + 1}` });
      connect(dns, port, node);
    }
    dns.data.settings.outputs = JSON.stringify(ordered);
    graph.nodes.push(dns);
  }
  if (value.fakedns !== undefined && !graph.nodes.some((n) => n.data.kind === 'fakedns')) {
    const pool = makeNode('fakedns', { x: 350, y: 900 }, 'native-fakedns');
    pool.data.settings = { pools: JSON.stringify(value.fakedns), servers: '[]' };
    graph.nodes.push(pool);
  }
  graph.xray = {
    version: 1,
    optionsNodeId: options.id,
    routingNodeId: filter.id,
    dnsNodeId,
    inboundOrder,
    outboundOrder,
    ...(outboundPool.length ? { outboundPool } : {}),
    balancerOrder,
    inboundsPresent: Object.hasOwn(value, 'inbounds'),
    outboundsPresent: Object.hasOwn(value, 'outbounds'),
    routingPresent: Object.hasOwn(value, 'routing'),
    rulesPresent: Object.hasOwn(routing, 'rules'),
    balancersPresent: Object.hasOwn(routing, 'balancers'),
    dnsServersPresent: jsonRecord(value.dns) && Object.hasOwn(value.dns, 'servers'),
    defaultsProjection: coreProjection(graph.defaults),
  };
  // A successful conversion must also survive protected save/load, including
  // node/field/position budgets. Reject it before touching the current workspace.
  const synced = parseGraph(serializeGraph(syncXrayConnections(graph)));
  // Fail explicitly if the imported shape cannot meet the no-change contract.
  const exported = compileXrayGraph(synced).config;
  if (!jsonEqual(value, exported))
    throw new Error(
      'This native configuration cannot yet be imported without changing fields; the current workspace is preserved.',
    );
  if (JSON.stringify(exported).length > LIMITS.configBytes)
    throw new Error('The exported configuration exceeds the service size limit.');
  return synced;
}

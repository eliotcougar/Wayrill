import { makeNode, makeProxyInbound } from '../graph/catalog';
import { readRuleTable, tableSettings, type TableRule } from '../graph/rules';
import { importXrayConfig } from '../graph/xrayImport';
import type { GraphState } from '../graph/types';

export type RoutingPacket = {
  inboundTag: string;
  network: string;
  port: number;
  domain: string;
  protocol: string;
  ip?: string;
  sourceIP?: string;
  sourcePort?: number;
  user?: string;
};
type Fields = Record<string, unknown>;
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : String(value).split(',');

// Deliberately independent of the compiler's predicate intersection/lowering.
// Only the literal syntax exercised below is supported; unknown fields fail.
function address(value: string): [bigint, number] {
  if (!value.includes(':'))
    return [value.split('.').reduce((n, byte) => (n << 8n) | BigInt(byte), 0n), 32];
  const [left, right] = value.split('::').map((part) => (part ? part.split(':') : []));
  const words = right
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return [words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n), 128];
}
function contains(cidr: string, ip: string) {
  const [base, prefix] = cidr.split('/');
  const [network, bits] = address(base),
    [target, targetBits] = address(ip);
  const shift = BigInt(bits - Number(prefix ?? bits));
  return bits === targetBits && network >> shift === target >> shift;
}
function matchesRouting(fields: Fields, packet: RoutingPacket): boolean {
  return Object.entries(fields).every(([key, value]) => {
    if (['type', 'outboundTag', 'balancerTag', 'ruleTag'].includes(key)) return true;
    if (key === 'domain' && fields.domains != null) return true;
    if (key === 'source' && fields.sourceIP != null) return true;
    if (value == null || (Array.isArray(value) && !value.length)) return true;
    if (key === 'port' || key === 'sourcePort')
      return list(value).some((range) => {
        const [low, high = low] = range.split('-').map(Number);
        const port = packet[key] ?? 0;
        return low <= port && port <= high;
      });
    if (key === 'domain' || key === 'domains')
      return list(value).some((entry) => {
        const [kind, name] = entry.toLowerCase().split(':');
        const host = packet.domain.toLowerCase();
        if (kind === 'full') return host === name;
        if (kind === 'domain') return host === name || host.endsWith(`.${name}`);
        throw new Error(`Unsupported fixture domain: ${entry}`);
      });
    if (['ip', 'sourceIP', 'source'].includes(key)) {
      const ip = key === 'ip' ? packet.ip : packet.sourceIP;
      return !!ip && list(value).some((cidr) => contains(cidr, ip));
    }
    if (key === 'protocol')
      return !!packet.protocol && list(value).some((p) => packet.protocol.startsWith(p));
    if (key === 'network')
      return list(value).some((network) => network.toLowerCase() === packet.network);
    if (key === 'user' || key === 'inboundTag') return list(value).includes(packet[key] ?? '');
    throw new Error(`Unsupported fixture predicate: ${key}`);
  });
}

function rowMatches(row: TableRule, packet: RoutingPacket) {
  if (row.matchAll) return true;
  if (row.native) return matchesRouting(row.native.original, packet);
  const predicates = Object.entries(row.conditions)
    .filter(([, text]) => text.trim())
    .map(([key, text]) => ({
      key,
      matched: matchesRouting(
        { [key]: ['port', 'sourcePort', 'network'].includes(key) ? text : text.split('\n') },
        packet,
      ),
    }));
  const targets = predicates.filter(({ key }) => key === 'domain' || key === 'ip');
  return (
    predicates.filter(({ key }) => key !== 'domain' && key !== 'ip').every((p) => p.matched) &&
    (row.targetMatch === 'all'
      ? targets.every((p) => p.matched)
      : !targets.length || targets.some((p) => p.matched))
  );
}

export function expectedRoute(graph: GraphState, packet: RoutingPacket): string {
  function next(id: string, port: string) {
    const edge = graph.edges.find((e) => e.source === id && e.sourceHandle === port);
    if (!edge) throw new Error(`Missing fixture edge: ${id}/${port}`);
    return visit(edge.target);
  }
  function visit(id: string): string {
    const node = graph.nodes.find((n) => n.id === id)!;
    if (node.data.kind !== 'routing-filter') return String(node.data.settings.tag);
    const table = readRuleTable(node.data.settings);
    const row = table.rules.find((r) => r.enabled && rowMatches(r, packet));
    return next(id, row?.output ?? table.defaultOutput);
  }
  if (graph.xray) return visit(graph.xray.routingNodeId);
  const input = graph.nodes.find((n) => n.data.settings.tag === packet.inboundTag)!;
  const dns =
    packet.port === 53 && (input.data.settings.mode !== 'http' || packet.network === 'tcp');
  return next(input.id, dns ? 'dns' : 'data');
}

export function compiledRoute(config: Record<string, unknown>, packet: RoutingPacket) {
  const rule = (config.routing as { rules: Fields[] }).rules.find((r) => matchesRouting(r, packet));
  const target =
    rule?.outboundTag ?? rule?.balancerTag ?? (config.outbounds as { tag: string }[])[0].tag;
  if (typeof target !== 'string') throw new Error('Missing fixture routing target.');
  return target;
}

export const routingBaseConfig = {
  inbounds: ['a', 'b'].map((tag, i) => ({
    tag,
    listen: '127.0.0.1',
    port: 1080 + i,
    protocol: 'socks',
    settings: { udp: true },
  })),
  outbounds: [
    { tag: 'direct', protocol: 'freedom' },
    { tag: 'other', protocol: 'freedom' },
    { tag: 'block', protocol: 'blackhole' },
  ],
};
const predicates: Fields[] = [
  { network: 'tcp' },
  { network: ['tcp', 'udp'] },
  { network: 'udp', port: '443' },
  { port: '80,443' },
  { port: '1000-2000' },
  { port: '1500-2500', network: 'tcp' },
  { domain: ['domain:example.test'] },
  { domain: ['full:api.example.test', 'full:other.test'] },
  { ip: ['192.0.2.0/24', '2001:db8::/32'] },
  { ip: ['192.0.2.128/25', '2001:db8:1::/48'] },
  { domain: ['full:other.test'], ip: ['198.51.100.0/24'] },
  { sourceIP: ['10.0.0.0/8'], sourcePort: '40000-50000' },
  { sourceIP: ['10.1.0.0/16'] },
  { protocol: ['http', 'tls'] },
  { protocol: ['http'] },
  { user: ['alice', 'bob'] },
  { user: ['bob'] },
  { inboundTag: ['a'] },
];

// Fixed seeds and a small acyclic topology make failures reproducible and readable.
// Two roots share descendants, whose fallbacks must not return to a later parent rule.
export function routingScenario(seed: number, native: boolean): GraphState {
  let state = seed;
  const pick = <T>(items: readonly T[]): T => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return items[Math.floor((state / 0x100000000) * items.length)];
  };
  const graph: GraphState = native
    ? importXrayConfig(JSON.stringify(routingBaseConfig))
    : { name: 'Generated routes', nodes: [], edges: [] };
  graph.name = `${native ? 'native' : 'authored'}-${seed}`;
  const wire = (source: string, sourceHandle: string, target: string) =>
    graph.edges.push({
      id: `${source}-${sourceHandle}`,
      source,
      sourceHandle,
      target,
      targetHandle: 'in',
    });
  const terminals = ['direct', 'other', 'block'];
  if (!native) {
    for (const tag of terminals) {
      const node = makeNode(
        tag === 'block' ? 'block-outbound' : 'direct-outbound',
        { x: 0, y: 0 },
        tag,
      );
      node.data.settings.tag = tag;
      graph.nodes.push(node);
    }
    for (const [i, tag] of ['a', 'b'].entries()) {
      const input = makeProxyInbound('socks', { x: 0, y: 0 }, tag);
      Object.assign(input.data.settings, { tag, port: 1080 + i });
      graph.nodes.push(input);
      wire(tag, 'data', `f${i}`);
      wire(tag, 'dns', 'block');
    }
  }
  const destination = (tag: string) => graph.nodes.find((n) => n.data.settings.tag === tag)!.id;
  if (native) {
    const root = graph.nodes.find((n) => n.id === graph.xray!.routingNodeId)!;
    graph.edges = graph.edges.filter((e) => e.source !== root.id);
    Object.assign(
      root.data.settings,
      tableSettings({
        outputs: ['a', 'b', 'block'].map((id) => ({ id, name: id })),
        defaultOutput: 'block',
        rules: ['a', 'b'].map((tag) => ({
          id: tag,
          name: tag,
          enabled: true,
          matchAll: false,
          conditions: { inboundTag: tag },
          output: tag,
        })),
      }),
    );
    wire(root.id, 'a', 'f0');
    wire(root.id, 'b', 'f1');
    wire(root.id, 'block', destination('block'));
  }
  for (let i = 0; i < 5; i++) {
    const node = makeNode('routing-filter', { x: i * 200, y: 0 }, `f${i}`);
    const targets = [...terminals, ...(i < 4 ? [`f${Math.max(2, i + 1)}`] : [])];
    const fields = [pick(predicates), pick(predicates), pick(predicates), pick(predicates)];
    const conditions = fields.map((f) =>
      Object.fromEntries(
        Object.entries(f).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(key === 'network' ? ',' : '\n') : String(value),
        ]),
      ),
    );
    let rules: TableRule[];
    if (native) {
      const imported = importXrayConfig(
        JSON.stringify({
          ...routingBaseConfig,
          routing: {
            rules: fields.map((f, index) => {
              const raw = { ...f };
              if (index % 2 === 0) {
                if (raw.domain) {
                  raw.domains = raw.domain;
                  delete raw.domain;
                }
                if (raw.sourceIP) {
                  raw.source = raw.sourceIP;
                  delete raw.sourceIP;
                }
              }
              if (index % 3 === 1)
                for (const [key, value] of Object.entries(raw))
                  if (Array.isArray(value)) raw[key] = value.join(',');
              if (index % 2 === 0 && raw.network)
                raw.network = list(raw.network).map((network) => network.toUpperCase());
              return { type: 'field', ...raw, outboundTag: 'block' };
            }),
          },
        }),
      );
      rules = readRuleTable(
        imported.nodes.find((n) => n.id === imported.xray!.routingNodeId)!.data.settings,
      ).rules;
    } else
      rules = conditions.map((c, index) => ({
        id: `r${index}`,
        name: `Rule ${index}`,
        enabled: true,
        matchAll: false,
        conditions: c,
        output: '',
        targetMatch: pick(['any', 'all'] as const),
      }));
    for (const [index, row] of rules.entries()) {
      row.output = index === 0 ? targets.at(-1)! : pick(targets);
      row.enabled = index !== 1 || seed % 3 !== 0;
    }
    if (seed % 4 === 0)
      rules[2] = { ...rules[2], native: undefined, conditions: {}, matchAll: true };
    Object.assign(
      node.data.settings,
      tableSettings({
        outputs: targets.map((id) => ({ id, name: id })),
        rules,
        defaultOutput: pick(targets),
      }),
    );
    graph.nodes.push(node);
    for (const target of targets)
      wire(node.id, target, target.startsWith('f') ? target : destination(target));
  }
  return graph;
}

export const routingSeeds = [1, 7, 19, 42, 73, 101, 256, 1024];
export function routingPackets(): RoutingPacket[] {
  const packets: RoutingPacket[] = [];
  const destinations = [
    ['', '192.0.2.1'],
    ['example.test', '192.0.2.200'],
    ['api.example.test', '198.51.100.1'],
    ['other.test', '2001:db8:1::1'],
    ['unrelated.test', '2001:db8:2::1'],
    ['', '2001:db9::1'],
  ];
  for (const inboundTag of ['a', 'b'])
    for (const network of ['tcp', 'udp'])
      for (const port of [53, 80, 443, 999, 1000, 1500, 2000, 2001, 2501])
        for (const [domain, ip] of destinations)
          // Pairwise combinations avoid coupling a protocol/user to one source
          // address or port, without an expensive full Cartesian product.
          for (const a of [0, 1, 2])
            for (const b of [0, 1, 2])
              packets.push({
                inboundTag,
                network,
                port,
                domain,
                ip,
                protocol: ['', 'http/2', 'tls'][a],
                sourceIP: ['10.1.2.3', '10.2.3.4', '172.16.1.1'][b],
                sourcePort: [39999, 45000, 50001][(a + b) % 3],
                user: ['', 'alice', 'bob'][(a + 2 * b) % 3],
              });
  return packets;
}

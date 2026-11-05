import { protocolSpecs } from './graph/protocols';
import { cloneJson, jsonArray, jsonEqual, jsonRecord, jsonText } from './graph/xrayJson';
import { remoteView, type RemoteView } from './remoteModel';
import { portRangesOverlap } from './graph/portRanges';

export interface LibraryEntry {
  id: string;
  title: string;
  group: 'Inbounds' | 'Rules & filters' | 'Outbounds' | 'User sets';
  protocol?: string;
}

export const nodeLibrary: LibraryEntry[] = [
  ...protocolSpecs
    .filter((spec) => !['tun-inbound', 'ics-tun'].includes(spec.kind))
    .filter((spec) => spec.direction !== 'inbound' || !['socks', 'http'].includes(spec.protocol))
    .map((spec): LibraryEntry => ({
      id: `${spec.direction}:${spec.protocol}`,
      title: spec.title,
      group: spec.direction === 'inbound' ? 'Inbounds' : 'Outbounds',
      protocol: spec.protocol,
    })),
  { id: 'routing', title: 'Routing filter', group: 'Rules & filters' },
  { id: 'dns', title: 'DNS handler', group: 'Rules & filters' },
  { id: 'resolver', title: 'DNS servers', group: 'Rules & filters' },
  { id: 'observatory', title: 'Observatory', group: 'Rules & filters' },
  { id: 'balancer', title: 'Policy group', group: 'Outbounds' },
  { id: 'users', title: 'User set', group: 'User sets' },
];

function uniqueTag(base: string, items: unknown[]) {
  const taken = new Set(items.filter(jsonRecord).map((item) => item.tag));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/** Add native definitions so the existing compiler remains the sole export path. */
export function createRemoteNode(view: RemoteView, entryId: string) {
  const entry = nodeLibrary.find((item) => item.id === entryId);
  if (!entry || entry.id === 'users') throw new Error('Choose a node type.');
  const config = cloneJson(view.normalized);
  const inbounds = jsonArray(config.inbounds) ? config.inbounds : [];
  const outbounds = jsonArray(config.outbounds) ? config.outbounds : [];
  const routing = jsonRecord(config.routing) ? config.routing : {};
  const dns = jsonRecord(config.dns) ? config.dns : {};
  const groups = jsonArray(routing.balancers) ? routing.balancers : [];
  const tags = [...inbounds, ...outbounds, ...groups, config.api];
  let id: string;
  if (entry.group === 'Inbounds') {
    let port = 10808;
    const ports = inbounds.filter(jsonRecord).map((item) => jsonText(item.port));
    while (port <= 65535 && ports.some((used) => portRangesOverlap(String(port), used))) port++;
    if (port > 65535) throw new Error('No unused listen port. Adjust an existing inbound first.');
    id = `native-in-${inbounds.length}`;
    config.inbounds = [
      ...inbounds,
      {
        tag: uniqueTag(entry.protocol!, tags),
        listen: '127.0.0.1',
        port,
        protocol: entry.protocol,
        settings: entry.protocol === 'vless' ? { decryption: 'none' } : {},
      },
    ];
  } else if (entry.protocol) {
    id = `native-out-${outbounds.length}`;
    config.outbounds = [
      ...outbounds,
      {
        tag: uniqueTag(entry.title.toLowerCase().replaceAll(' ', '-'), tags),
        protocol: entry.protocol,
        settings: {},
      },
    ];
  } else if (entryId === 'balancer') {
    id = `native-balancer-${groups.length}`;
    config.routing = {
      ...routing,
      balancers: [
        ...groups,
        {
          tag: uniqueTag('group', tags),
          selector: [],
          strategy: { type: 'random' },
        },
      ],
    };
  } else if (entryId === 'resolver') {
    const servers = jsonArray(dns.servers) ? dns.servers : [];
    id = `native-resolver-${servers.length}`;
    config.dns = { ...dns, servers: [...servers, { address: 'localhost' }] };
  } else if (entryId === 'dns') {
    id = 'native-dns';
    config.dns = dns;
  } else if (entryId === 'observatory') {
    id = 'native-observatory';
    if (!config.observatory && !config.burstObservatory)
      config.observatory = { subjectSelector: [] };
  } else {
    id = 'native-routing';
    config.routing = routing;
  }
  return {
    view: jsonEqual(config, view.normalized) ? view : remoteView(JSON.stringify(config)),
    id,
  };
}

export function inlineSettings(id: string, value: unknown) {
  return (
    id.startsWith('native-resolver-') ||
    (id.startsWith('native-out-') &&
      jsonRecord(value) &&
      ['freedom', 'direct', 'blackhole', 'block', 'loopback', 'dns'].includes(
        String(value.protocol),
      ))
  );
}

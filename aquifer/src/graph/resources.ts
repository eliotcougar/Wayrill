import { jsonArray, parseJson } from './xrayJson';
import { readRuleTable, tableSettings, routingListEntries } from './rules';
import type { GlobalDefaults, GraphState, RuleNodeData } from './types';

export type ResourceKind = 'geoip' | 'geosite';
export interface ResourceExtra {
  id: string;
  name: string;
  kind: ResourceKind;
  source: 'url' | 'disk';
  url: string;
}
export interface ResourceSet {
  mode: 'packaged' | 'url';
  packaged: 'original' | 'russian';
  geoipUrl: string;
  geositeUrl: string;
  autoUpdate: boolean;
  intervalHours: number;
  extras: ResourceExtra[];
}
export interface ResourceFilePlan {
  file: string;
  kind: ResourceKind;
  url: string;
  autoUpdate: boolean;
  intervalHours: number;
  fetchOnUse: boolean;
}
// v2rayN ServiceLib/Global.cs: GeoUrl and GeoFilesSources, verified 2026-10-07.
export const resourceProviders = [
  {
    name: 'Loyalsoldier · v2rayN default',
    geoip: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat',
    geosite: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat',
  },
  {
    name: 'V2Fly',
    geoip: 'https://github.com/v2fly/geoip/releases/latest/download/geoip.dat',
    geosite: 'https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat',
  },
  {
    name: 'RunetFreedom · Russian blacklist',
    geoip:
      'https://github.com/runetfreedom/russia-v2ray-rules-dat/releases/latest/download/geoip.dat',
    geosite:
      'https://github.com/runetfreedom/russia-v2ray-rules-dat/releases/latest/download/geosite.dat',
  },
  {
    name: 'Chocolate4U · Iranian rules',
    geoip: 'https://github.com/Chocolate4U/Iran-v2ray-rules/releases/latest/download/geoip.dat',
    geosite: 'https://github.com/Chocolate4U/Iran-v2ray-rules/releases/latest/download/geosite.dat',
  },
];
export const factoryResources = (): ResourceSet => ({
  mode: 'packaged',
  packaged: 'original',
  geoipUrl: resourceProviders[0].geoip,
  geositeUrl: resourceProviders[0].geosite,
  autoUpdate: false,
  intervalHours: 24,
  extras: [],
});
export function resourceUrlProblem(text: string): string | null {
  if (!text) return 'Choose a source URL.';
  try {
    const url = new URL(text);
    if (
      text.length > 8192 ||
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    )
      return 'Use an HTTPS URL without login credentials or a fragment.';
  } catch {
    return 'Enter a valid HTTPS URL.';
  }
  return null;
}
export function parseResources(value: unknown): ResourceSet {
  if (!value || typeof value !== 'object' || jsonArray(value))
    throw new Error('Invalid resource set.');
  const s = value as ResourceSet;
  if (
    Object.keys(s).some(
      (k) =>
        ![
          'mode',
          'packaged',
          'geoipUrl',
          'geositeUrl',
          'autoUpdate',
          'intervalHours',
          'extras',
        ].includes(k),
    ) ||
    !['packaged', 'url'].includes(s.mode) ||
    !['original', 'russian'].includes(s.packaged) ||
    typeof s.autoUpdate !== 'boolean' ||
    !Number.isInteger(s.intervalHours) ||
    s.intervalHours < 1 ||
    s.intervalHours > 8760 ||
    !jsonArray(s.extras) ||
    s.extras.length > 16
  )
    throw new Error('Use a valid resource set and an update period of 1–8760 hours.');
  for (const kind of ['geoip', 'geosite'] as const) {
    const problem =
      typeof s[`${kind}Url`] === 'string'
        ? resourceUrlProblem(s[`${kind}Url`])
        : 'Enter a source URL.';
    if (problem) throw new Error(`${kind}: ${problem}`);
  }
  const ids = new Set<string>(),
    names = new Set<string>();
  for (const e of s.extras) {
    if (
      !e ||
      typeof e !== 'object' ||
      Object.keys(e).some((k) => !['id', 'name', 'kind', 'source', 'url'].includes(k)) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(e.id) ||
      ids.has(e.id) ||
      typeof e.name !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.dat$/.test(e.name) ||
      names.has(e.name.toLowerCase()) ||
      [
        'geoip.dat',
        'geosite.dat',
        'ru-geoip.dat',
        'ru-geosite.dat',
        'russian-geoip.dat',
        'russian-geosite.dat',
        'wayrill-global-geoip.dat',
        'wayrill-global-geosite.dat',
      ].includes(e.name.toLowerCase()) ||
      !['geoip', 'geosite'].includes(e.kind) ||
      !['url', 'disk'].includes(e.source) ||
      typeof e.url !== 'string'
    )
      throw new Error('Extra files need unique names such as office.dat and a valid file type.');
    if (e.source === 'url' && resourceUrlProblem(e.url))
      throw new Error(`${e.name}: ${resourceUrlProblem(e.url)}`);
    ids.add(e.id);
    names.add(e.name.toLowerCase());
  }
  return structuredClone(s);
}
export function readResources(defaults?: GlobalDefaults): ResourceSet {
  return parseResources(defaults?.resources ?? factoryResources());
}
export function resourceFiles(set: ResourceSet, id: string): ResourceFilePlan[] {
  const prefix = set.packaged === 'russian' ? 'russian-' : '';
  return [
    ...(['geoip', 'geosite'] as const).map((kind) => ({
      file: set.mode === 'packaged' ? `${prefix}${kind}.dat` : `wayrill-${id}-${kind}.dat`,
      fetchOnUse: set.mode === 'url',
      kind,
      url: set[`${kind}Url`],
      autoUpdate: set.autoUpdate,
      intervalHours: set.intervalHours,
    })),
    ...set.extras.map((e) => ({
      file: `wayrill-${e.id}.dat`,
      fetchOnUse: e.source === 'url',
      kind: e.kind,
      url: e.source === 'url' ? e.url : '',
      autoUpdate: e.source === 'url' && set.autoUpdate,
      intervalHours: set.intervalHours,
    })),
  ];
}
export function resourcePlans(graph: GraphState): ResourceFilePlan[] {
  return resourceFiles(readResources(graph.defaults), 'global');
}
/** All filters share the resource menu. Only matcher fields in a compilation copy change. */
export function resourceCompilationGraph(graph: GraphState): GraphState {
  const copy = structuredClone(graph),
    set = readResources(graph.defaults);
  const files = resourceFiles(set, 'global'),
    ip = files[0].file,
    site = files[1].file;
  const matcherKeys = new Set([
    'domain',
    'domains',
    'ip',
    'source',
    'sourceIP',
    'localIP',
    'domainsExcluded',
    'ipsExcluded',
    'expectedIPs',
    'unexpectedIPs',
    'expectIPs',
    'sniffDomainsExcluded',
    'sniffIPsExcluded',
  ]);
  const rewrite = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      if (/^[[{]/.test(v.trim())) {
        try {
          return JSON.stringify(rewrite(parseJson(v), key));
        } catch {
          /* A plain matcher can begin with a bracket. */
        }
      }
      if (!matcherKeys.has(key) && key !== 'host-key') return v;
      return v
        .split('\n')
        .map((term) => {
          const match = /^(\s*)(geoip|geosite):(.*)$/.exec(term);
          if (match) {
            const file = match[2] === 'geoip' ? ip : site;
            if (file !== `${match[2]}.dat`) return `${match[1]}ext:${file}:${match[3]}`;
          }
          const ext = /^(\s*)ext:([^:]+):(.*)$/.exec(term);
          const extra = ext && set.extras.find((e) => e.name === ext[2]);
          return extra ? `${ext[1]}ext:wayrill-${extra.id}.dat:${ext[3]}` : term;
        })
        .join('\n');
    }
    if (jsonArray(v)) return v.map((x) => rewrite(x, key));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          key === 'hosts' ? (rewrite(k, 'host-key') as string) : k,
          rewrite(x, k),
        ]),
      );
    return v;
  };
  for (const node of copy.nodes) {
    if (node.data.kind === 'routing-filter') {
      const table = readRuleTable(node.data.settings);
      table.rules = table.rules.map((row) => ({
        ...row,
        conditions: Object.fromEntries(
          Object.entries(row.conditions).map(([key, value]) => [
            key,
            ['domain', 'ip', 'sourceIP', 'localIP'].includes(key)
              ? routingListEntries(value, key).join('\n')
              : value,
          ]),
        ),
      }));
      node.data.settings = { ...node.data.settings, ...tableSettings(table) };
    }
    node.data.settings = rewrite(node.data.settings) as RuleNodeData['settings'];
    if (node.data.native)
      node.data.native = rewrite(node.data.native) as NonNullable<RuleNodeData['native']>;
  }
  if (copy.defaults)
    copy.defaults.settings = rewrite(copy.defaults.settings) as GlobalDefaults['settings'];
  return copy;
}

export function resourceDependencies(config: unknown): string[] {
  const files = new Set<string>();
  const matchers = new Set([
    'domain',
    'domains',
    'ip',
    'source',
    'sourceIP',
    'localIP',
    'expectedIPs',
    'unexpectedIPs',
    'expectIPs',
    'domainsExcluded',
    'ipsExcluded',
    'sniffDomainsExcluded',
    'sniffIPsExcluded',
  ]);
  const visit = (v: unknown, key = ''): void => {
    if (typeof v === 'string') {
      if (!matchers.has(key) && key !== 'host-key') return;
      if (v.startsWith('geoip:')) files.add('geoip.dat');
      if (v.startsWith('geosite:')) files.add('geosite.dat');
      const ext = /^ext:([^:]+):/.exec(v);
      if (ext) files.add(ext[1]);
    } else if (jsonArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === 'object')
      Object.entries(v).forEach(([k, x]) => {
        if (key === 'hosts') visit(k, 'host-key');
        visit(x, k);
      });
  };
  visit(config);
  return [...files].sort();
}

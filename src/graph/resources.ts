import { policyProfileId } from './profileIdentity';
import { editSourceConditions } from './ruleSourceEdits';
import type { PolicyProfile } from './policySources';
import { jsonArray, parseJson } from './xrayJson';
import { readRuleTable, tableSettings, routingListEntries } from './rules';
import type { GlobalDefaults, GraphState, RuleNodeData } from './types';

export type ResourceKind = 'geoip' | 'geosite';
export interface ResourceFile {
  id: string;
  name: string;
  kind: ResourceKind;
  url: string;
  enabled: boolean;
  autoUpdate: boolean;
  intervalHours: number;
  throughWayrill: boolean;
}
export interface ResourceSet {
  files: ResourceFile[];
  reloadAfterAutoUpdates: boolean;
}
export interface ResourceFilePlan {
  id: string;
  file: string;
  kind: ResourceKind;
  url: string;
  autoUpdate: boolean;
  intervalHours: number;
  fetchOnUse: boolean;
  throughWayrill: boolean;
}
// Original follows XTLS/Xray-rules-dat (GeoIP lite + GeoSite).
// Alternative sources remain explicit user choices.
export const resourceProviders = [
  {
    name: 'XTLS · Xray default',
    geoip: 'https://github.com/XTLS/Xray-rules-dat/releases/latest/download/geoip-lite.dat',
    geosite: 'https://github.com/XTLS/Xray-rules-dat/releases/latest/download/geosite.dat',
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
  {
    name: 'Loyalsoldier',
    geoip: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat',
    geosite: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat',
  },
];
export const packagedResources: ResourceFile[] = (
  [
    ['', 0],
    ['ru-', 2],
    ['ir-', 3],
    ['cn-', 4],
  ] as const
).flatMap(([prefix, provider]) =>
  (['geoip', 'geosite'] as const).map((kind) => ({
    id: `packaged-${prefix}${kind}`,
    name: `${prefix}${kind}.dat`,
    kind,
    url: resourceProviders[provider][kind],
    enabled: prefix === '',
    autoUpdate: false,
    intervalHours: 24,
    throughWayrill: false,
  })),
);
export const factoryResources = (): ResourceSet => ({
  files: structuredClone(packagedResources),
  reloadAfterAutoUpdates: true,
});
export function resourceFilename(file: ResourceFile): string {
  return file.name;
}
export function resourceSourceName(file: ResourceFile): string {
  return (
    resourceProviders.find((provider) => provider[file.kind] === file.url)?.name.split(' · ')[0] ??
    (file.url ? 'Custom URL' : 'Local file')
  );
}
export function selectResource(set: ResourceSet, id: string, enabled: boolean): ResourceSet {
  const selected = set.files.find((file) => file.id === id);
  return {
    ...set,
    files: set.files.map((file) =>
      file.id === id
        ? { ...file, enabled }
        : enabled && file.kind === selected?.kind
          ? { ...file, enabled: false }
          : file,
    ),
  };
}
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
  if (!('files' in value) && 'mode' in value) value = upgradeResources(value);
  const s = value as ResourceSet;
  if (
    Object.keys(s).some((k) => !['files', 'reloadAfterAutoUpdates'].includes(k)) ||
    typeof s.reloadAfterAutoUpdates !== 'boolean' ||
    !jsonArray(s.files) ||
    s.files.length > 64
  )
    throw new Error('Use a valid resource set and an update period of 1–8760 hours.');
  const ids = new Set<string>(),
    names = new Set<string>();
  const selected = new Set<ResourceKind>();
  for (const e of s.files) {
    if (
      !e ||
      typeof e !== 'object' ||
      Object.keys(e).some(
        (k) =>
          ![
            'id',
            'name',
            'kind',
            'url',
            'enabled',
            'autoUpdate',
            'intervalHours',
            'throughWayrill',
          ].includes(k),
      ) ||
      typeof e.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(e.id) ||
      ids.has(e.id) ||
      typeof e.name !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.dat$/.test(e.name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.dat$/i.test(e.name) ||
      names.has(e.name.toLowerCase()) ||
      !['geoip', 'geosite'].includes(e.kind) ||
      typeof e.url !== 'string' ||
      typeof e.enabled !== 'boolean' ||
      typeof e.autoUpdate !== 'boolean' ||
      typeof e.throughWayrill !== 'boolean' ||
      packagedResources.some((p) => p.id === e.id && p.kind !== e.kind)
    )
      throw new Error('Extra files need unique names such as office.dat and a valid file type.');
    if (!Number.isInteger(e.intervalHours) || e.intervalHours < 1 || e.intervalHours > 8760)
      throw new Error(`${e.name}: use an update period of 1–8760 hours.`);
    if (e.url && resourceUrlProblem(e.url))
      throw new Error(`${e.name}: ${resourceUrlProblem(e.url)}`);
    if (!e.url && e.autoUpdate) throw new Error(`${e.name}: choose a URL for auto-updates.`);
    if (e.enabled && selected.has(e.kind)) throw new Error(`Select only one ${e.kind} file.`);
    if (e.enabled) selected.add(e.kind);
    ids.add(e.id);
    names.add(e.name.toLowerCase());
  }
  return structuredClone(s);
}
/** Normalize the previous menu once; exports and subsequent saves use rows only. */
function upgradeResources(value: object): ResourceSet {
  const old = value as {
    mode: string;
    packaged: string;
    geoipUrl: string;
    geositeUrl: string;
    autoUpdate: boolean;
    intervalHours: number;
    extras: (Pick<ResourceFile, 'id' | 'name' | 'kind' | 'url'> & { source: string })[];
  };
  if (
    !['packaged', 'url'].includes(old.mode) ||
    !['original', 'russian'].includes(old.packaged) ||
    !jsonArray(old.extras)
  )
    throw new Error('Invalid resource set.');
  const set = factoryResources();
  set.files.forEach((file) => {
    file.enabled = false;
  });
  for (const kind of ['geoip', 'geosite'] as const) {
    const file: ResourceFile =
      old.mode === 'url'
        ? {
            id: `global-${kind}`,
            name: `global-${kind}.dat`,
            kind,
            url: '',
            enabled: true,
            autoUpdate: false,
            intervalHours: 24,
            throughWayrill: false,
          }
        : set.files.find(
            (f) => f.id === `packaged-${old.packaged === 'russian' ? 'ru-' : ''}${kind}`,
          )!;
    Object.assign(file, {
      url: old[`${kind}Url`],
      enabled: true,
      autoUpdate: old.autoUpdate,
      intervalHours: old.intervalHours,
    });
    if (old.mode === 'url') set.files.push(file);
  }
  for (const extra of old.extras)
    set.files.push({
      id: extra.id,
      name: extra.name,
      kind: extra.kind,
      url: extra.source === 'disk' ? '' : extra.url,
      enabled: false,
      autoUpdate: extra.source === 'url' && old.autoUpdate,
      intervalHours: old.intervalHours,
      throughWayrill: false,
    });
  return set;
}
export function readResources(defaults?: GlobalDefaults): ResourceSet {
  return parseResources(defaults?.resources ?? factoryResources());
}
export function resourceFiles(set: ResourceSet): ResourceFilePlan[] {
  return set.files.map((file) => ({
    id: file.id,
    file: resourceFilename(file),
    kind: file.kind,
    url: file.url,
    autoUpdate: file.autoUpdate,
    intervalHours: file.intervalHours,
    throughWayrill: file.throughWayrill,
    fetchOnUse:
      !!file.url && !packagedResources.some((p) => p.id === file.id && p.url === file.url),
  }));
}
export function resourcePlans(graph: GraphState): ResourceFilePlan[] {
  return resourceFiles(readResources(graph.defaults));
}
/** All filters share the resource menu. Only matcher fields in a compilation copy change. */
export function resourceCompilationGraph(graph: GraphState): GraphState {
  const set = readResources(graph.defaults);
  const primary = (kind: ResourceKind) => {
    const selected = set.files.find((file) => file.kind === kind && file.enabled);
    if (!selected)
      throw new Error(
        `Select a default ${kind === 'geoip' ? 'GeoIP' : 'GeoSite'} file in Resource files.`,
      );
    return resourceFilename(selected);
  };
  return rewriteResourceGraph(
    graph,
    (term) => {
      const match = /^(\s*!*)(geoip|geosite):(.*)$/.exec(term);
      if (match) {
        const file = primary(match[2] as ResourceKind);
        if (file !== `${match[2]}.dat`) return `${match[1]}ext:${file}:${match[3]}`;
      }
      const ext = /^(\s*!*)(?:ext|ext-ip|ext-domain|ext-site):([^:]+):(.*)$/.exec(term);
      const extra = ext && set.files.find((e) => e.name.toLowerCase() === ext[2].toLowerCase());
      if (extra) return `${ext[1]}ext:${resourceFilename(extra)}:${ext[3]}`;
      if (ext && /^russian-geo(ip|site)\.dat$/.test(ext[2]))
        return `${ext[1]}ext:${ext[2].replace('russian-', 'ru-')}:${ext[3]}`;
      return term;
    },
    true,
  );
}
export function renameResourceReferences(graph: GraphState, resources: ResourceSet): GraphState {
  const names = new Map<string, string>();
  for (const previous of readResources(graph.defaults).files) {
    const next = resources.files.find((file) => file.id === previous.id);
    if (next && next.name !== previous.name) names.set(previous.name.toLowerCase(), next.name);
  }
  if (!names.size) return graph;
  const renamed = rewriteResourceGraph(graph, (term) => {
    const match = /^(\s*!*)(ext|ext-ip|ext-domain|ext-site):([^:]+):(.*)$/.exec(term);
    const name = match && names.get(match[3].toLowerCase());
    return name ? `${match[1]}${match[2]}:${name}:${match[4]}` : term;
  });
  for (const node of renamed.nodes) {
    if (node.data.kind !== 'routing-filter') continue;
    const original = graph.nodes.find((old) => old.id === node.id)!;
    const previous = readRuleTable(original.data.settings);
    const table = readRuleTable(node.data.settings);
    table.rules = table.rules.map((row) => {
      const old = previous.rules.find((entry) => entry.id === row.id);
      return old?.source ? editSourceConditions(old, row.conditions) : row;
    });
    node.data.settings = { ...node.data.settings, ...tableSettings(table) };
  }
  return renamed;
}
function rewriteResourceGraph(
  graph: GraphState,
  selector: (term: string) => string,
  compiling = false,
): GraphState {
  const copy = structuredClone(graph);
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
  const rewrite = (v: unknown, key = '', literal = false): unknown => {
    if (typeof v === 'string') {
      // Baselines describe the authored projection, not executable matchers.
      if (key === 'commonBaseline') return v;
      if (
        [
          'rules',
          'hosts',
          'json',
          'sources',
          'steps',
          'sniffDomainsExcluded',
          'sniffIPsExcluded',
        ].includes(key) &&
        /^[[{]/.test(v.trim())
      ) {
        let parsed: unknown;
        try {
          parsed = parseJson(v);
        } catch {
          /* A plain matcher can begin with a bracket. */
        }
        if (parsed !== undefined) {
          const next = rewrite(parsed, key);
          return parsed === next ? v : JSON.stringify(next);
        }
      }
      if (!matcherKeys.has(key) && key !== 'host-key') return v;
      const entries =
        !compiling || literal || key === 'host-key' ? v.split('\n') : routingListEntries(v, key);
      const next = entries.map(selector);
      return next.some((entry, index) => entry !== entries[index]) ? next.join('\n') : v;
    }
    if (jsonArray(v)) {
      const next = v.map((x) => rewrite(x, key, true));
      return next.some((x, i) => x !== v[i]) ? next : v;
    }
    if (v && typeof v === 'object') {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          const nextKey = key === 'hosts' ? (rewrite(k, 'host-key') as string) : k;
          const nextValue = rewrite(x, k);
          changed ||= nextKey !== k || nextValue !== x;
          return [nextKey, nextValue];
        }),
      );
      if (!changed) return v;
      // A real matcher change inside a portable definition changes its identity.
      // Never repair an already-invalid identity supplied by an imported graph.
      const ref = v as PolicyProfile;
      if (
        ref.type === 'profile' &&
        ref.profile &&
        next.profile !== ref.profile &&
        typeof ref.id === 'string' &&
        policyProfileId(ref.profile) === ref.id
      )
        next.id = policyProfileId(next.profile as PolicyProfile['profile']);
      return next;
    }
    return v;
  };
  for (const node of copy.nodes) {
    if (compiling && node.data.kind === 'routing-filter') {
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
  const visit = (v: unknown, key = '', arrayEntry = false): void => {
    if (typeof v === 'string') {
      if (!matchers.has(key) && key !== 'host-key') return;
      // Xray StringList splits scalar fields at commas, but not array entries
      // or DNS host keys. Keep regular-expression commas literal in arrays.
      for (const term of arrayEntry || key === 'host-key' ? [v] : v.split(',')) {
        const text = term.replace(/^!+/, '');
        if (text.startsWith('geoip:')) files.add('geoip.dat');
        if (text.startsWith('geosite:')) files.add('geosite.dat');
        const ext = /^(?:ext|ext-ip|ext-domain|ext-site):([^:]+):/.exec(text);
        if (ext) files.add(ext[1]);
      }
    } else if (jsonArray(v)) v.forEach((x) => visit(x, key, true));
    else if (v && typeof v === 'object')
      Object.entries(v).forEach(([k, x]) => {
        const object = v as Record<string, unknown>;
        if (k === 'source' && object.sourceIP != null) return;
        if (
          k === 'expectIPs' &&
          (typeof object.expectedIPs === 'string' ||
            (jsonArray(object.expectedIPs) && object.expectedIPs.length > 0))
        )
          return;
        if (key === 'hosts') visit(k, 'host-key');
        visit(x, k);
      });
  };
  visit(config);
  return [...files].sort();
}

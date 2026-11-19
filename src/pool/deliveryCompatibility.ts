import { parseGraph, toDocument } from '../graph/model';
import { readRuleApplications, type PoolApplicationSelector } from '../graph/applications';
import {
  readRuleTable,
  resolveRuleApplications,
  tableSettings,
  type RuleTable,
  type TableRule,
} from '../graph/rules';
import { detachTrafficSource } from '../graph/trafficRuleSource';
import { jsonRecord, ownValue } from '../graph/xrayJson';
import type { PoolDelivery } from './delivery';
import type { PoolBundle } from './model';

type ApplicationExtension = {
  enabled: boolean;
  selectors: PoolApplicationSelector[];
};
type RuleExtensions = Record<string, ApplicationExtension>;
const feature = 'trafficApplicationsV1';

function legacyRules(rules: TableRule[]) {
  const extensions: [string, ApplicationExtension][] = [];
  const baseline = rules.map((rule) => {
    const applications = rule.applications ?? [];
    const selectors = applications.filter((app) => app.kind === 'pool');
    if (!selectors.length) return rule;
    extensions.push([rule.id, { enabled: rule.enabled, selectors }]);
    return {
      ...rule,
      enabled: resolveRuleApplications(rule, undefined, false).enabled,
      applications: applications.filter((app) => app.kind !== 'pool'),
    };
  });
  return extensions.length ? { baseline, extensions: Object.fromEntries(extensions) } : undefined;
}

function restoreRules(rules: TableRule[], extensions: unknown) {
  if (!jsonRecord(extensions)) throw new Error('Invalid Pool application extensions.');
  return rules.map((rule) => {
    const extra = ownValue(extensions, rule.id);
    if (extra === undefined) return rule;
    if (!jsonRecord(extra) || typeof extra.enabled !== 'boolean')
      throw new Error('Invalid Pool application extension.');
    const selectors = readRuleApplications(extra.selectors);
    if (!selectors.length || selectors.some((selector) => selector.kind !== 'pool'))
      throw new Error('Invalid Pool application extension.');
    return {
      ...rule,
      enabled: extra.enabled,
      applications: [...(rule.applications ?? []), ...selectors],
    };
  });
}

function editGraphRules(
  bundle: PoolBundle,
  edit: (id: string, table: RuleTable) => RuleTable | undefined,
) {
  const graph = parseGraph(bundle.graph);
  let changed = false;
  for (const node of graph.nodes) {
    if (node.data.kind !== 'routing-filter') continue;
    const table = edit(node.id, readRuleTable(node.data.settings));
    if (!table) continue;
    changed = true;
    node.data.settings = { ...node.data.settings, ...tableSettings(table) };
  }
  return changed ? { ...bundle, graph: JSON.stringify(toDocument(graph)) } : bundle;
}

// The base catalog must be usable by older readers. Attach optional features
// alongside graph and layer records so an older reader never persists them.
export function encodePoolDelivery(delivery: PoolDelivery): PoolDelivery {
  return {
    ...delivery,
    graphs: delivery.graphs.map((entry) => {
      const extensions: [string, RuleExtensions][] = [];
      const bundle = editGraphRules(entry.bundle, (id, table) => {
        const detached = table.source ? detachTrafficSource(table) : table;
        const projected = legacyRules(detached.rules);
        if (projected) extensions.push([id, projected.extensions]);
        if (projected) return { ...detached, rules: projected.baseline };
        return detached === table ? undefined : detached;
      });
      return extensions.length
        ? { ...entry, bundle, extensions: { [feature]: Object.fromEntries(extensions) } }
        : bundle === entry.bundle
          ? entry
          : { ...entry, bundle };
    }),
    layers: delivery.layers.map((layer) => {
      if (layer.data.kind !== 'traffic') return layer;
      const { filter } = layer.data;
      const table = filter.table.source ? detachTrafficSource(filter.table) : filter.table;
      const projected = legacyRules(table.rules);
      if (!projected && table === filter.table) return layer;
      return {
        ...layer,
        data: {
          ...layer.data,
          filter: { ...filter, table: projected ? { ...table, rules: projected.baseline } : table },
        },
        ...(projected ? { extensions: { [feature]: projected.extensions } } : {}),
      };
    }),
  };
}

function applicationExtension(extensions: unknown) {
  return jsonRecord(extensions) ? ownValue(extensions, feature) : undefined;
}

export function restorePoolDelivery(delivery: PoolDelivery): PoolDelivery {
  return {
    ...delivery,
    graphs: delivery.graphs.map(({ extensions, ...entry }) => {
      const apps = applicationExtension(extensions);
      if (apps === undefined) return entry;
      if (!jsonRecord(apps)) throw new Error('Invalid Pool graph application extensions.');
      const bundle = editGraphRules(entry.bundle, (id, table) => {
        const extra = ownValue(apps, id);
        return extra === undefined
          ? undefined
          : { ...table, rules: restoreRules(table.rules, extra) };
      });
      return { ...entry, bundle };
    }),
    layers: delivery.layers.map(({ extensions, ...layer }) => {
      const apps = applicationExtension(extensions);
      if (apps === undefined || layer.data.kind !== 'traffic') return layer;
      const { filter } = layer.data;
      return {
        ...layer,
        data: {
          ...layer.data,
          filter: {
            ...filter,
            table: { ...filter.table, rules: restoreRules(filter.table.rules, apps) },
          },
        },
      };
    }),
  };
}

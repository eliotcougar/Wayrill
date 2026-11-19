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
import { isDeviceLayer, readDeviceLayer } from './deviceLayers';
import type { PoolBundle } from './model';

type ApplicationExtension = {
  enabled: boolean;
  selectors: PoolApplicationSelector[];
};
type RuleExtensions = Record<string, ApplicationExtension>;
const feature = 'trafficApplicationsV1';
const executableFeature = 'trafficExecutableAppsV1';

function legacyRules(rules: TableRule[]) {
  const extensions: [string, ApplicationExtension][] = [];
  const executables: [string, ApplicationExtension][] = [];
  const baseline = rules.map((rule) => {
    const applications = rule.applications ?? [];
    const selectors = applications.filter((app) => app.kind === 'pool');
    if (!selectors.length) return rule;
    const legacy = selectors.filter(({ identity }) => !identity.executable);
    if (legacy.length) extensions.push([rule.id, { enabled: rule.enabled, selectors: legacy }]);
    if (legacy.length !== selectors.length)
      executables.push([rule.id, { enabled: rule.enabled, selectors }]);
    return {
      ...rule,
      enabled: resolveRuleApplications(rule, undefined, false).enabled,
      applications: applications.filter((app) => app.kind !== 'pool'),
    };
  });
  return extensions.length || executables.length
    ? {
        baseline,
        legacy: extensions.length ? Object.fromEntries(extensions) : undefined,
        executable: executables.length ? Object.fromEntries(executables) : undefined,
      }
    : undefined;
}

function restoreRules(rules: TableRule[], legacy: unknown, executable: unknown) {
  if (
    (legacy !== undefined && !jsonRecord(legacy)) ||
    (executable !== undefined && !jsonRecord(executable))
  )
    throw new Error('Invalid Pool application extensions.');
  return rules.map((rule) => {
    const extra =
      (jsonRecord(executable) ? ownValue(executable, rule.id) : undefined) ??
      (jsonRecord(legacy) ? ownValue(legacy, rule.id) : undefined);
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
  const deviceLayers = delivery.layers.filter(({ data }) => isDeviceLayer(data));
  const graphs = delivery.graphs.map((entry) => {
    const extensions: [string, RuleExtensions][] = [];
    const executables: [string, RuleExtensions][] = [];
    const bundle = editGraphRules(entry.bundle, (id, table) => {
      const detached = table.source ? detachTrafficSource(table) : table;
      const projected = legacyRules(detached.rules);
      if (projected?.legacy) extensions.push([id, projected.legacy]);
      if (projected?.executable) executables.push([id, projected.executable]);
      if (projected) return { ...detached, rules: projected.baseline };
      return detached === table ? undefined : detached;
    });
    return extensions.length || executables.length
      ? {
          ...entry,
          bundle,
          extensions: {
            ...(extensions.length && { [feature]: Object.fromEntries(extensions) }),
            ...(executables.length && { [executableFeature]: Object.fromEntries(executables) }),
          },
        }
      : bundle === entry.bundle
        ? entry
        : { ...entry, bundle };
  });
  const layers = delivery.layers
    .filter(({ data }) => !isDeviceLayer(data))
    .map((layer) => {
      if (layer.data.kind !== 'traffic') return layer;
      const { filter } = layer.data;
      const table = filter.table.source ? detachTrafficSource(filter.table) : filter.table;
      const projected = legacyRules(table.rules);
      if (!projected && table === filter.table) return layer;
      return {
        ...layer,
        data: {
          ...layer.data,
          filter: {
            ...filter,
            table: projected ? { ...table, rules: projected.baseline } : table,
          },
        },
        ...(projected && {
          extensions: {
            ...(projected.legacy && { [feature]: projected.legacy }),
            ...(projected.executable && { [executableFeature]: projected.executable }),
          },
        }),
      };
    });
  const portableExecutables = [...graphs, ...layers].some(
    ({ extensions }) => jsonRecord(extensions) && Object.hasOwn(extensions, executableFeature),
  );
  return {
    ...delivery,
    ...(deviceLayers.length > 0 || portableExecutables
      ? {
          extensions: {
            ...(jsonRecord(delivery.extensions) ? delivery.extensions : {}),
            ...(deviceLayers.length && { deviceLayersV1: deviceLayers }),
            ...(portableExecutables && { portableExecutablesV1: true }),
          },
        }
      : {}),
    ...(deviceLayers.length && {
      defaultLayers: delivery.defaultLayers.filter(
        ({ id }) => !deviceLayers.some((layer) => layer.id === id),
      ),
    }),
    graphs,
    layers,
  };
}

function applicationExtensions(extensions: unknown) {
  return jsonRecord(extensions)
    ? ([ownValue(extensions, feature), ownValue(extensions, executableFeature)] as const)
    : ([undefined, undefined] as const);
}

export function restorePoolDelivery(delivery: PoolDelivery): PoolDelivery {
  const raw = jsonRecord(delivery.extensions) ? delivery.extensions.deviceLayersV1 : undefined;
  const devices = raw === undefined ? [] : readDeviceLayers(raw, delivery);
  return {
    ...delivery,
    graphs: delivery.graphs.map(({ extensions, ...entry }) => {
      const [apps, executables] = applicationExtensions(extensions);
      if (apps === undefined && executables === undefined) return entry;
      if (
        (apps !== undefined && !jsonRecord(apps)) ||
        (executables !== undefined && !jsonRecord(executables))
      )
        throw new Error('Invalid Pool graph application extensions.');
      const bundle = editGraphRules(entry.bundle, (id, table) => {
        const extra = jsonRecord(apps) ? ownValue(apps, id) : undefined;
        const portable = jsonRecord(executables) ? ownValue(executables, id) : undefined;
        return extra === undefined && portable === undefined
          ? undefined
          : { ...table, rules: restoreRules(table.rules, extra, portable) };
      });
      return { ...entry, bundle };
    }),
    layers: [
      ...delivery.layers.map(({ extensions, ...layer }) => {
        const [apps, executables] = applicationExtensions(extensions);
        if ((apps === undefined && executables === undefined) || layer.data.kind !== 'traffic')
          return layer;
        const { filter } = layer.data;
        return {
          ...layer,
          data: {
            ...layer.data,
            filter: {
              ...filter,
              table: {
                ...filter.table,
                rules: restoreRules(filter.table.rules, apps, executables),
              },
            },
          },
        };
      }),
      ...devices,
    ],
  };
}

function readDeviceLayers(raw: unknown, delivery: PoolDelivery): PoolDelivery['layers'] {
  if (!Array.isArray(raw) || raw.length > 500)
    throw new Error('Invalid Pool Windows settings layers.');
  const used = new Set(delivery.layers.map(({ id }) => id));
  return raw.map((item: unknown) => {
    if (
      !jsonRecord(item) ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 128 ||
      used.has(item.id)
    )
      throw new Error('Invalid Pool Windows settings layer.');
    used.add(item.id);
    return { id: item.id, name: item.name, data: readDeviceLayer(item.data) };
  });
}

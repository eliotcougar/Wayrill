import { applyDefaults, defaultsProblems, factoryDefaults } from './defaults';
import { coreProjection } from './xrayProjection';
import { udpListenerFields } from './udpListeners';
import { jsonRecord, patchProjection, parseJson, parseJsonObject } from './xrayJson';
import type { GlobalDefaults, GraphState, SettingValue } from './types';

const read = (o: Record<string, unknown>, key: string) =>
  o[Object.keys(o).find((k) => k.toLowerCase() === key.toLowerCase()) ?? key];
const option = (value: unknown, options: string[]) =>
  options.find((o) => o.toLowerCase() === String(value).toLowerCase());

export function hydrateCoreDefaults(
  root: Record<string, unknown>,
  base: GlobalDefaults = factoryDefaults(),
): GlobalDefaults {
  const d = { ...base.settings },
    log = jsonRecord(root.log) ? root.log : {},
    routing = jsonRecord(root.routing) ? root.routing : {},
    metrics = jsonRecord(root.metrics) ? root.metrics : {};
  const set = (key: string, value: SettingValue | undefined) => {
    if (value === undefined) delete d[key];
    else d[key] = value;
  };
  const boolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
  for (const [key, variable] of Object.entries(udpListenerFields)) {
    const value = jsonRecord(root.env) ? root.env[variable] : undefined;
    set(
      key,
      typeof value === 'string' && /^\d+$/.test(value) && Number(value) % 1024 === 0
        ? Number(value) / 1024
        : undefined,
    );
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  set('logLevel', option(read(log, 'loglevel'), ['debug', 'info', 'warning', 'error', 'none']));
  set('dnsLog', boolean(read(log, 'dnsLog')));
  set('maskAddress', option(read(log, 'maskAddress'), ['', 'quarter', 'half', 'full']));
  set(
    'routingDomainStrategy',
    option(read(routing, 'domainStrategy'), ['AsIs', 'IPIfNonMatch', 'IPOnDemand']),
  );
  set('statistics', jsonRecord(root.stats) ? true : undefined);
  set('policy', jsonRecord(root.policy) ? JSON.stringify(root.policy) : undefined);
  set('metricsEnabled', jsonRecord(root.metrics) ? true : undefined);
  set('metricsTag', text(read(metrics, 'tag')));
  set('metricsListen', text(read(metrics, 'listen')));
  const candidate: GlobalDefaults = { version: 1, settings: d };
  // Native extensions remain in the core node if the narrower global-policy
  // schema cannot represent them. The native visual editor preserves them too.
  if (defaultsProblems(candidate).some((p) => p.severity === 'error' && p.fieldKey === 'policy'))
    delete d.policy;
  if (
    defaultsProblems(candidate).some(
      (p) => p.severity === 'error' && ['metricsTag', 'metricsListen'].includes(p.fieldKey ?? ''),
    )
  )
    delete d.metricsEnabled;
  return candidate;
}
export function updateImportedCoreDefaults(
  graph: GraphState,
  defaults: GlobalDefaults,
): GraphState {
  const next = applyDefaults(graph, defaults);
  if (!graph.xray) return next;
  return {
    ...next,
    xray: { ...graph.xray, defaultsProjection: coreProjection(next.defaults!) },
    nodes: next.nodes.map((n) =>
      n.id === graph.xray!.optionsNodeId
        ? {
            ...n,
            data: {
              ...n.data,
              settings: {
                ...n.data.settings,
                json: JSON.stringify(
                  patchProjection(
                    parseJson(String(n.data.settings.json)),
                    coreProjection(graph.defaults!),
                    coreProjection(next.defaults!),
                  ),
                  null,
                  2,
                ),
              },
            },
          }
        : n,
    ),
  };
}

export function syncImportedCoreDefaults(graph: GraphState): GraphState {
  if (!graph.xray) return graph;
  const node = graph.nodes.find((n) => n.id === graph.xray!.optionsNodeId);
  if (!node) return graph;
  const defaults = hydrateCoreDefaults(
    parseJsonObject(String(node.data.settings.json)),
    graph.defaults,
  );
  // A form edit already changed the root JSON. Move the defaults comparison
  // baseline with it so clearing a field remains an omission on compilation.
  return {
    ...graph,
    defaults,
    xray: { ...graph.xray, defaultsProjection: coreProjection(defaults) },
  };
}

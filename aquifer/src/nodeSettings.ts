import { cloneJson, jsonArray, jsonEqual, jsonRecord } from './graph/xrayJson';
import { remoteView, type RemoteView } from './remoteModel';
import { inboundUserProtocol, inboundUsers, stable } from './users/model';
import { renameDestination } from './renameDestination';
import { get, objectAt } from './nativeProperties';
import {
  apiPlumbing,
  editableRouting,
  restoreApiRules,
  updateApiListeners,
  type ApiListener,
} from './apiPlumbing';

const graphSections = new Set([
  'inbounds',
  'outbounds',
  'routing',
  'dns',
  'observatory',
  'burstobservatory',
]);
const globalExcluded = new Set([...graphSections].filter((key) => key !== 'routing'));
const routeCollections = new Set(['rules', 'balancers']);

function renameApi(config: Record<string, unknown>, next: unknown) {
  const previous = get(objectAt(config, 'api'), 'tag');
  const tag = jsonRecord(next) ? get(next, 'tag') : undefined;
  if (previous === tag) return;
  const outbounds = get(config, 'outbounds');
  if (
    typeof tag === 'string' &&
    Array.isArray(outbounds) &&
    outbounds.some((item) => jsonRecord(item) && get(item, 'tag') === tag)
  )
    throw new Error('An outbound already uses this API routing tag.');
  const rules = get(objectAt(config, 'routing'), 'rules');
  if (!previous || !Array.isArray(rules)) return;
  for (const rule of rules) {
    if (!jsonRecord(rule) || get(rule, 'outboundTag') !== previous) continue;
    if (typeof tag !== 'string' || !tag.trim())
      throw new Error(
        'The management API is used by routing rules. Remove those destinations before disabling it.',
      );
    rule[property(rule, 'outboundTag')] = tag;
  }
}

function locator(view: RemoteView, id: string): { path: string[]; schema: string } | undefined {
  const numbered = /^(native-in|native-out|native-balancer|native-resolver)-(\d+)$/.exec(id);
  if (numbered) {
    const index = numbered[2];
    switch (numbered[1]) {
      case 'native-in':
        return { path: ['inbounds', index], schema: 'InboundDetourConfig' };
      case 'native-out':
        return { path: ['outbounds', index], schema: 'OutboundDetourConfig' };
      case 'native-balancer':
        return { path: ['routing', 'balancers', index], schema: 'BalancingRule' };
      case 'native-resolver':
        return { path: ['dns', 'servers', index], schema: 'NameServerConfig' };
    }
  }
  if (id === 'native-routing') return { path: ['routing'], schema: 'RouterConfig' };
  if (id === 'native-dns') return { path: ['dns'], schema: 'DNSConfig' };
  if (id === 'remote-api') return { path: ['api'], schema: 'APIConfig' };
  if (id === 'native-observatory')
    return view.normalized.burstObservatory === undefined
      ? { path: ['observatory'], schema: 'ObservatoryConfig' }
      : { path: ['burstObservatory'], schema: 'BurstObservatoryConfig' };
  return undefined;
}

function property(parent: Record<string, unknown>, name: string) {
  return Object.keys(parent).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
}

/** A DNS query tag participates in inboundTag routing just like a listener tag. */
function renameSource(
  config: Record<string, unknown>,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  const oldTag = get(previous, 'tag'),
    newTag = get(next, 'tag');
  if (oldTag === newTag) return;
  const dns = objectAt(config, 'dns');
  const sources = [
    ...(Array.isArray(get(config, 'inbounds')) ? (get(config, 'inbounds') as unknown[]) : []),
    dns,
    ...(Array.isArray(get(dns, 'servers')) ? (get(dns, 'servers') as unknown[]) : []),
  ].filter(jsonRecord);
  const others = sources.filter((source) => source !== previous);
  if (
    typeof newTag === 'string' &&
    newTag &&
    others.some((source) => get(source, 'tag') === newTag)
  )
    throw new Error('Another inbound or DNS source already uses this tag.');
  if (typeof oldTag !== 'string' || !oldTag) return;
  const shared = others.some((source) => get(source, 'tag') === oldTag);
  const rules = get(objectAt(config, 'routing'), 'rules');
  if (!Array.isArray(rules)) return;
  for (const rule of rules) {
    if (!jsonRecord(rule)) continue;
    const key = property(rule, 'inboundTag'),
      value = rule[key];
    if (value !== oldTag && !(jsonArray(value) && value.includes(oldTag))) continue;
    if (typeof newTag !== 'string' || !newTag)
      throw new Error(
        'This tag is used by routing rules. Keep a tag, or remove those inbound conditions first.',
      );
    rule[key] = shared
      ? [...new Set([...(jsonArray(value) ? value : [value]), newTag])]
      : jsonArray(value)
        ? value.map((tag) => (tag === oldTag ? newTag : tag))
        : newTag;
  }
}

function target(config: Record<string, unknown>, path: string[]) {
  let parent: unknown = config;
  for (const key of path.slice(0, -1)) {
    parent = Array.isArray(parent)
      ? (parent as unknown[])[Number(key)]
      : jsonRecord(parent)
        ? parent[property(parent, key)]
        : undefined;
  }
  const last = path.at(-1)!;
  if (Array.isArray(parent))
    return { parent: parent as Record<string, unknown> | unknown[], key: last };
  if (!jsonRecord(parent)) throw new Error('This settings section is unavailable.');
  return { parent, key: property(parent, last) };
}

export function nodeSettings(view: RemoteView, id: string) {
  if (id === 'native-options')
    return {
      schema: 'Config',
      apiListeners: apiPlumbing(view.original).listeners,
      value: Object.fromEntries(
        Object.entries(view.original).flatMap(([key, entry]) => {
          if (globalExcluded.has(key.toLowerCase())) return [];
          if (key.toLowerCase() === 'routing' && jsonRecord(entry))
            return [
              [
                key,
                Object.fromEntries(
                  Object.entries(entry).filter(
                    ([name]) => !routeCollections.has(name.toLowerCase()),
                  ),
                ),
              ],
            ];
          return [[key, entry]];
        }),
      ),
    };
  const location = locator(view, id);
  if (!location) return undefined;
  const { parent, key } = target(view.original, location.path);
  const value = Array.isArray(parent) ? parent[Number(key)] : (parent[key] ?? {});
  return {
    schema: location.schema,
    value:
      location.schema === 'RouterConfig'
        ? editableRouting(view.original, jsonRecord(value) ? value : {})
        : value,
  };
}

export function replaceNodeSettings(
  view: RemoteView,
  id: string,
  value: unknown,
  apiListeners?: ApiListener[],
): RemoteView {
  const editor = nodeSettings(view, id);
  if (!editor) throw new Error('This node has no independent settings.');
  if (
    jsonEqual(editor.value, value) &&
    (apiListeners === undefined || jsonEqual(apiListeners, editor.apiListeners))
  )
    return view;
  let config = cloneJson(view.original);
  if (id === 'native-options') {
    if (
      !jsonRecord(value) ||
      Object.keys(value).some((key) => globalExcluded.has(key.toLowerCase()))
    )
      throw new Error('Edit graph sections on their own nodes.');
    config = updateApiListeners(
      config,
      apiListeners ?? apiPlumbing(config).listeners,
      jsonRecord(get(value, 'api')),
    );
    renameApi(config, get(value, 'api'));
    const routingKey = property(config, 'routing');
    const currentRouting = config[routingKey];
    const nextRouting = value[property(value, 'routing')];
    if (
      nextRouting !== undefined &&
      (!jsonRecord(nextRouting) ||
        Object.keys(nextRouting).some((key) => routeCollections.has(key.toLowerCase())))
    )
      throw new Error('Edit rules and policy groups on their own nodes.');
    for (const key of Object.keys(config))
      if (!graphSections.has(key.toLowerCase())) delete config[key];
    for (const [key, entry] of Object.entries(value)) {
      if (key.toLowerCase() === 'routing') continue;
      Object.defineProperty(config, key, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (currentRouting !== undefined || nextRouting !== undefined)
      config[routingKey] = {
        ...(jsonRecord(nextRouting) ? nextRouting : {}),
        ...Object.fromEntries(
          jsonRecord(currentRouting)
            ? Object.entries(currentRouting).filter(([key]) =>
                routeCollections.has(key.toLowerCase()),
              )
            : [],
        ),
      };
  } else {
    const location = locator(view, id)!;
    if (location.schema === 'RouterConfig' && jsonRecord(value))
      value = restoreApiRules(config, value);
    if (location.schema === 'APIConfig') renameApi(config, value);
    if (
      !jsonRecord(value) &&
      !(location.schema === 'NameServerConfig' && typeof value === 'string')
    )
      throw new Error('Enter a settings object.');
    if (
      location.schema === 'InboundDetourConfig' &&
      jsonRecord(value) &&
      jsonRecord(editor.value)
    ) {
      const oldAccounts = inboundUsers(editor.value);
      if (stable(oldAccounts) !== stable(inboundUsers(value)))
        throw new Error('Edit inbound accounts through User sets.');
      if (inboundUserProtocol(editor.value) !== inboundUserProtocol(value))
        throw new Error(
          'Changing the inbound credential type requires importing a new configuration.',
        );
    }
    if (
      (location.schema === 'OutboundDetourConfig' || location.schema === 'BalancingRule') &&
      jsonRecord(value) &&
      jsonRecord(editor.value)
    )
      renameDestination(
        config,
        editor.value,
        value,
        location.schema === 'BalancingRule',
        Number(location.path.at(-1)),
      );
    const { parent, key } = target(config, location.path);
    const previous = Array.isArray(parent) ? parent[Number(key)] : parent[key];
    if (
      jsonRecord(previous) &&
      jsonRecord(value) &&
      ['InboundDetourConfig', 'DNSConfig', 'NameServerConfig'].includes(location.schema)
    ) {
      renameSource(config, previous, value);
      if (location.schema === 'DNSConfig') {
        const oldServers = get(previous, 'servers'),
          nextServers = get(value, 'servers');
        if (jsonArray(oldServers) && jsonArray(nextServers)) {
          for (const [index, server] of oldServers.entries()) {
            if (
              !jsonRecord(server) ||
              !get(server, 'tag') ||
              nextServers.some(
                (next) => jsonRecord(next) && get(next, 'tag') === get(server, 'tag'),
              )
            )
              continue;
            // Existing tags identify reordered servers. A renamed server keeps
            // its slot, or its address when servers were added/removed as well.
            const candidates = nextServers.filter(
              (next) => jsonRecord(next) && get(next, 'address') === get(server, 'address'),
            );
            const next =
              candidates.length === 1
                ? candidates[0]
                : oldServers.length === nextServers.length
                  ? nextServers[index]
                  : undefined;
            if (jsonRecord(next)) {
              const nextTag = get(next, 'tag');
              if (
                nextTag &&
                oldServers.some((old) => jsonRecord(old) && get(old, 'tag') === nextTag)
              )
                continue;
              renameSource(config, server, next);
            }
          }
        }
      }
    }
    if (Array.isArray(parent)) parent[Number(key)] = value;
    else parent[key] = value;
  }
  return remoteView(JSON.stringify(config));
}

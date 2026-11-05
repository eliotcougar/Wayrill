import { jsonArray, jsonRecord } from './graph/xrayJson';
import { get, objectAt, propertyKey } from './nativeProperties';

type Settings = Record<string, unknown>;
const objects = (value: unknown): Settings[] => (jsonArray(value) ? value.filter(jsonRecord) : []);

/** Operates on the caller's private configuration copy; no source or graph is mutated. */
export function renameDestination(
  config: Settings,
  previous: Settings,
  next: Settings,
  group: boolean,
  index: number,
) {
  const oldTag = get(previous, 'tag'),
    newTag = get(next, 'tag');
  if (oldTag === newTag) return;
  const routing = objectAt(config, 'routing'),
    outbounds = objects(get(config, 'outbounds'));
  const groups = objects(get(routing, 'balancers'));
  if (typeof newTag !== 'string' || !newTag.trim())
    throw new Error('Keep a nonempty tag for this destination.');
  if ((group ? groups : outbounds).some((item, i) => i !== index && get(item, 'tag') === newTag))
    throw new Error(`Another ${group ? 'policy group' : 'outbound'} already uses this tag.`);
  if (typeof oldTag !== 'string' || !oldTag) return;
  const replace = (item: Settings, key: string) => {
    if (get(item, key) === oldTag) item[propertyKey(item, key)] = newTag;
  };
  for (const rule of objects(get(routing, 'rules')))
    replace(rule, group ? 'balancerTag' : 'outboundTag');
  if (group) return;
  for (const item of groups) replace(item, 'fallbackTag');
  replace(objectAt(config, 'geodata'), 'outbound');
  const streams: Settings[] = [];
  for (const item of [...outbounds, ...objects(get(config, 'inbounds'))]) {
    replace(objectAt(item, 'proxySettings'), 'tag');
    if (jsonRecord(get(item, 'streamSettings'))) streams.push(objectAt(item, 'streamSettings'));
  }
  for (const stream of streams) {
    replace(objectAt(stream, 'sockopt'), 'dialerProxy');
    const xhttp = objectAt(stream, 'xhttpSettings');
    for (const parent of [xhttp, objectAt(xhttp, 'extra')]) {
      if (jsonRecord(get(parent, 'downloadSettings')))
        streams.push(objectAt(parent, 'downloadSettings'));
    }
  }
  // Prefix selectors must keep exactly the same membership after a rename. Only an
  // isolated exact tag can be rewritten automatically; broad prefixes need intent.
  const before = outbounds
    .map((item) => get(item, 'tag'))
    .filter((tag): tag is string => typeof tag === 'string');
  const after = before.map((tag) => (tag === oldTag ? newTag : tag));
  for (const [item, key] of [
    ...groups.map((item) => [item, 'selector'] as const),
    ...[objectAt(config, 'observatory'), objectAt(config, 'burstObservatory')].map(
      (item) => [item, 'subjectSelector'] as const,
    ),
  ]) {
    const value = get(item, key);
    const prefixes =
      typeof value === 'string'
        ? [value]
        : jsonArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [];
    if (!prefixes.length) continue;
    const select = (tags: string[], prefixes: string[]) =>
      tags.filter((tag) => prefixes.some((prefix) => tag.startsWith(prefix)));
    const expected = new Set(
      select(before, prefixes).map((tag) => (tag === oldTag ? newTag : tag)),
    );
    const same = (prefixes: string[]) => {
      const selected = select(after, prefixes);
      return selected.length === expected.size && selected.every((tag) => expected.has(tag));
    };
    if (same(prefixes)) continue;
    const updated = prefixes.map((prefix) =>
      prefix === oldTag && before.filter((tag) => tag.startsWith(prefix)).length === 1
        ? newTag
        : prefix,
    );
    if (!same(updated))
      throw new Error(
        'This rename changes policy group or observatory prefix membership. Adjust those prefixes first, or keep a tag matching the existing prefixes.',
      );
    item[propertyKey(item, key)] = typeof value === 'string' ? updated[0] : updated;
  }
}

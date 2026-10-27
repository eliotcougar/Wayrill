import { getDefinition, isNodeKind } from './graph/catalog';
import { globalFields } from './graph/defaults';
import { routingConditionFields } from './graph/rules';
import { jsonArray, jsonRecord, checkJson } from './graph/xrayJson';
import { policyProfileId } from './graph/profileIdentity';
import { parseStash, serializeStash, type Stash, type Profile } from './profiles/import';
import { THEME_STORAGE_KEY } from './theme';
import type { SettingDefinition } from './graph/types';

type Direction = 'write' | 'read';
const record = (value: unknown) => (jsonRecord(value) ? value : {});
function structured(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return jsonRecord(parsed) || jsonArray(parsed) ? parsed : value;
  } catch {
    return value;
  } // Incomplete JSON drafts remain text rather than being lost.
}
function lines(value: unknown, direction: Direction) {
  if (direction === 'write' && typeof value === 'string')
    return value === '' ? [] : value.split('\n');
  if (direction === 'read' && jsonArray(value)) {
    if (!value.every((v) => typeof v === 'string')) throw new Error('Rule entries must be text.');
    return value.join('\n');
  }
  return value;
}
function conditions(value: unknown, direction: Direction) {
  if (!jsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, text]) => [
      key,
      routingConditionFields.find((f) => f.key === key)?.list
        ? lines(text, direction)
        : key === 'attrs'
          ? direction === 'write'
            ? structured(text)
            : jsonRecord(text)
              ? JSON.stringify(text)
              : text
          : text,
    ]),
  );
}
/** Only known JSON/list fields are expanded. Credentials and arbitrary JSON-looking text stay opaque. */
export function portableTrafficRule(value: unknown, direction: Direction): unknown {
  if (!jsonRecord(value)) return value;
  const source = record(value.source),
    edits = record(source.edits);
  return {
    ...value,
    conditions: conditions(value.conditions, direction),
    ...(value.source === undefined
      ? {}
      : {
          source: {
            ...source,
            base: portableTrafficRule(source.base, direction),
            edits: {
              ...edits,
              ...(edits.conditions === undefined
                ? {}
                : { conditions: conditions(edits.conditions, direction) }),
            },
          },
        }),
  };
}
function reference(value: unknown, direction: Direction, depth: number): unknown {
  if (!jsonRecord(value) || value.type !== 'profile' || !jsonRecord(value.profile)) return value;
  const profile = owner(value.profile, direction, depth + 1);
  return {
    ...value,
    profile,
    ...(direction === 'read' ? { id: policyProfileId(profile as unknown as Profile) } : {}),
  };
}
function nestedSetting(
  kind: string,
  key: string,
  value: unknown,
  direction: Direction,
  depth: number,
): unknown {
  if (kind === 'routing-filter' && key === 'rules' && jsonArray(value))
    return value.map((row) => portableTrafficRule(row, direction));
  if (kind === 'dns-routing-filter' && key === 'rules' && jsonArray(value))
    return value.map((row) =>
      !jsonRecord(row)
        ? row
        : {
            ...row,
            ...Object.fromEntries(
              ['domains', 'expectedIPs', 'unexpectedIPs'].map((k) => [k, lines(row[k], direction)]),
            ),
          },
    );
  if (kind === 'policy-group' && key === 'sources' && jsonRecord(value))
    return {
      ...value,
      ...(jsonArray(value.manual)
        ? { manual: value.manual.map((r) => reference(r, direction, depth)) }
        : {}),
      ...(value.fallback === undefined
        ? {}
        : { fallback: reference(value.fallback, direction, depth) }),
      ...(jsonArray(value.subscriptions)
        ? {
            subscriptions: value.subscriptions.map((s) =>
              !jsonRecord(s)
                ? s
                : {
                    ...s,
                    ...(jsonArray(s.entries)
                      ? { entries: s.entries.map((r) => reference(r, direction, depth)) }
                      : {}),
                  },
            ),
          }
        : {}),
    };
  if (kind === 'proxy-chain' && key === 'steps' && jsonRecord(value) && jsonArray(value.steps))
    return {
      ...value,
      steps: value.steps.map((s) =>
        !jsonRecord(s) ? s : { ...s, outbound: reference(s.outbound, direction, depth) },
      ),
    };
  return value;
}
function settings(
  value: unknown,
  fields: SettingDefinition[],
  direction: Direction,
  kind = '',
  depth = 0,
) {
  if (!jsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, text]) => {
      if (fields.find((f) => f.key === key)?.type !== 'json') return [key, text];
      const parsed = direction === 'write' ? structured(text) : text;
      const result = nestedSetting(kind, key, parsed, direction, depth);
      return [
        key,
        direction === 'read' && (jsonRecord(result) || jsonArray(result))
          ? JSON.stringify(result)
          : result,
      ];
    }),
  );
}
function owner(
  value: Record<string, unknown>,
  direction: Direction,
  depth = 0,
): Record<string, unknown> {
  if (depth > 16) throw new Error('Prepared outbound nesting exceeds 16 levels.');
  if (typeof value.kind !== 'string' || !isNodeKind(value.kind))
    throw new Error('Unknown configuration node type.');
  return {
    ...value,
    settings: settings(
      value.settings,
      getDefinition(value.kind).fields,
      direction,
      value.kind,
      depth,
    ),
  };
}
function graph(value: unknown, direction: Direction) {
  if (!jsonRecord(value) || !jsonArray(value.nodes)) throw new Error('Invalid backup graph.');
  return {
    ...value,
    nodes: value.nodes.map((n) =>
      !jsonRecord(n) || !jsonRecord(n.data) ? n : { ...n, data: owner(n.data, direction) },
    ),
    ...(jsonRecord(value.defaults)
      ? {
          defaults: {
            ...value.defaults,
            settings: settings(value.defaults.settings, globalFields, direction),
          },
        }
      : {}),
  };
}
function stash(value: unknown, direction: Direction): unknown {
  if (direction === 'read' && record(value).version === 4) return value;
  const native = direction === 'write' ? parseStash(JSON.stringify(value)) : value;
  if (!jsonRecord(native) || !jsonArray(native.groups) || native.groups.length > 500)
    throw new Error('Invalid backup Stash.');
  let count = 0;
  const result = {
    ...native,
    groups: native.groups.map((group) => {
      if (!jsonRecord(group) || !jsonArray(group.entries))
        throw new Error('Invalid backup subscription.');
      if ((count += group.entries.length) > 50000)
        throw new Error('The Stash supports 50,000 entries.');
      return {
        ...group,
        entries: group.entries.map((entry) => {
          if (!jsonRecord(entry)) throw new Error('Invalid backup outbound.');
          const profile = jsonRecord(entry.profile)
            ? owner(entry.profile, direction)
            : entry.profile;
          const result: Record<string, unknown> = {
            ...entry,
            profile,
            ...(jsonRecord(entry.draft) ? { draft: owner(entry.draft, direction) } : {}),
          };
          if (
            direction === 'read' &&
            jsonRecord(profile) &&
            jsonRecord(result.health) &&
            result.health.profileId !== policyProfileId(profile as unknown as Profile)
          )
            delete result.health;
          return result;
        }),
      };
    }),
  };
  // Compact only at the internal validation/storage boundary; files contain full entry definitions.
  return direction === 'read'
    ? (JSON.parse(serializeStash(result as unknown as Stash)) as unknown)
    : result;
}
export function portableBackup(value: unknown, direction: Direction): unknown {
  checkJson(value);
  if (!jsonRecord(value)) throw new Error('Invalid backup contents.');
  const result = { ...value };
  if (value.graph !== undefined) result.graph = graph(value.graph, direction);
  if (value.stash !== undefined) result.stash = stash(value.stash, direction);
  if (jsonRecord(value.linkedStash))
    result.linkedStash = {
      ...value.linkedStash,
      document: stash(value.linkedStash.document, direction),
    };
  if (jsonArray(value.filters))
    result.filters = value.filters.map((f) => (!jsonRecord(f) ? f : owner(f, direction)));
  if (jsonRecord(value.preferences))
    result.preferences = Object.fromEntries(
      Object.entries(value.preferences).map(([key, text]) => [
        key,
        key === THEME_STORAGE_KEY
          ? text
          : direction === 'write'
            ? structured(text)
            : jsonRecord(text)
              ? JSON.stringify(text)
              : text,
      ]),
    );
  return result;
}

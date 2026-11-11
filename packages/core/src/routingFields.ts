import { jsonEqual, patchProjection } from './xrayJson';
import type { NativeProjection } from './nativeProjection';

/** The pinned core gives `domains` precedence, but `sourceIP` precedence over `source`. */
export function effectiveRoutingFields(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    ...(raw.domains != null ? { domain: raw.domains } : {}),
    ...(raw.sourceIP == null && raw.source != null ? { sourceIP: raw.source } : {}),
  };
}

/** Preserve untouched native JSON; a named edit replaces all spellings of that predicate. */
export function projectNativeRule(
  rule: { native?: NativeProjection },
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!rule.native) return fields;
  const result = patchProjection(rule.native.original, rule.native.projection, fields) as Record<
    string,
    unknown
  >;
  for (const [key, alias] of [
    ['domain', 'domains'],
    ['sourceIP', 'source'],
  ])
    if (!jsonEqual(rule.native.projection[key], fields[key])) delete result[alias];
  return result;
}

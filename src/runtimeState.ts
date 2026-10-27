import { jsonArray } from './graph/xrayJson';
// Compare effective configuration, ignoring object key order and service-owned log sinks.
function stable(value: unknown): unknown {
  if (jsonArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export function matchesCapture(draft: unknown, applied: unknown): boolean {
  return JSON.stringify(stable(draft ?? null)) === JSON.stringify(stable(applied ?? null));
}
export function effectiveConfig(config: Record<string, unknown>): string {
  const log =
    config.log && typeof config.log === 'object' ? (config.log as Record<string, unknown>) : {};
  return JSON.stringify(
    stable({
      ...config,
      log: {
        loglevel: log.loglevel ?? 'warning',
        access: 'none',
        error: '',
        ...(log.dnsLog === true ? { dnsLog: true } : {}),
        ...(log.maskAddress ? { maskAddress: log.maskAddress } : {}),
      },
    }),
  );
}
export function matchesApplied(
  draft: Record<string, unknown> | null,
  applied: Record<string, unknown> | null,
): boolean {
  return !!draft && !!applied && effectiveConfig(draft) === effectiveConfig(applied);
}

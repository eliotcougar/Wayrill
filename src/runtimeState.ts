import { GENERATED_DNS_TAG } from './graph/tags';
import { jsonArray, jsonRecord } from './graph/xrayJson';

// Compare effective configuration independently of runtime metadata and key order.
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
function stripManagedResolverIds(dns: unknown): unknown {
  if (!jsonRecord(dns) || dns.tag !== GENERATED_DNS_TAG || !jsonArray(dns.servers)) return dns;
  // 0.37.20 saved resolver IDs in generated configurations. Only the generated
  // graph comparison treats these IDs as metadata.
  return {
    ...dns,
    servers: dns.servers.map((server: unknown) =>
      jsonRecord(server)
        ? Object.fromEntries(Object.entries(server).filter(([key]) => key.toLowerCase() !== 'id'))
        : server,
    ),
  };
}
export function effectiveConfig(config: Record<string, unknown>, generatedDns = false): string {
  const log =
    config.log && typeof config.log === 'object' ? (config.log as Record<string, unknown>) : {};
  return JSON.stringify(
    stable({
      ...config,
      ...(generatedDns && config.dns !== undefined
        ? { dns: stripManagedResolverIds(config.dns) }
        : {}),
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
  generatedDns = false,
): boolean {
  return (
    !!draft &&
    !!applied &&
    effectiveConfig(draft, generatedDns) === effectiveConfig(applied, generatedDns)
  );
}

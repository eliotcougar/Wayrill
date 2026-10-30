import { dnsIpLiteral } from './graph/addressValidation';
import { jsonArray, jsonRecord } from './graph/xrayJson';
import type { DisplayNames } from './graph/displayNames';
import type { CapturePlan } from './graph/capture';

export type DiagnosticConfiguration = {
  config: Record<string, unknown>;
  capture?: CapturePlan | null;
  displayNames?: DisplayNames;
};
export type RoutingDiagnosticResult = {
  ruleIndex?: number | null;
  outboundTag?: string;
  balancerTag?: string;
  needsIPs?: boolean;
  warnings?: string[];
  error?: string;
  rcode?: string;
  answers?: { name: string; type: number; ttl: number; value: string; synthetic?: boolean }[];
  trace?: { elapsedMs: number; message: string }[];
};

export function diagnosticInputs(plan: DiagnosticConfiguration | null) {
  const rows = plan?.config.inbounds;
  if (!jsonArray(rows)) return [];
  return rows
    .filter(jsonRecord)
    .filter((row) => typeof row.tag === 'string')
    .map((row) => ({
      tag: String(row.tag),
      name: plan?.displayNames?.inbound[String(row.tag)] || String(row.tag),
    }));
}
export function diagnosticHandlers(plan: DiagnosticConfiguration | null) {
  const rows = plan?.config.outbounds;
  if (!jsonArray(rows)) return [];
  return rows
    .filter(jsonRecord)
    .filter((row) => row.protocol === 'dns' && typeof row.tag === 'string')
    .map((row) => ({
      tag: String(row.tag),
      name: plan?.displayNames?.outbound[String(row.tag)] || String(row.tag),
    }));
}
export function diagnosticDestination(value: string) {
  const destination = value.trim().replace(/^\[|\]$/g, '');
  if (!destination) throw new Error('Enter a destination.');
  if (dnsIpLiteral(destination)) return { domain: '', ips: [destination] };
  const domain = destination.replace(/\.$/, '').toLowerCase();
  if (
    domain.length > 253 ||
    !domain
      .split('.')
      .every(
        (part) =>
          part.length > 0 && part.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(part),
      )
  )
    throw new Error('Enter a domain or IP address, without a URL or port.');
  return { domain, ips: [] as string[] };
}
export function diagnosticIPs(value: string) {
  const ips = [...new Set(value.split(/[\s,;]+/).filter(Boolean))];
  if (ips.length > 64 || ips.some((ip) => !dnsIpLiteral(ip)))
    throw new Error('Enter valid destination IP addresses, separated by commas.');
  return ips;
}
export function diagnosticTrail(plan: DiagnosticConfiguration, result: RoutingDiagnosticResult) {
  return result.ruleIndex != null
    ? (plan.displayNames?.routing?.[String(result.ruleIndex)] ?? [])
    : (plan.displayNames?.routingDefault ?? []);
}
export function diagnosticRule(plan: DiagnosticConfiguration, result: RoutingDiagnosticResult) {
  const routing = plan.config.routing;
  return jsonRecord(routing) && jsonArray(routing.rules) && result.ruleIndex != null
    ? routing.rules[result.ruleIndex]
    : undefined;
}

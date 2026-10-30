import { jsonArray, jsonRecord, parseJson } from './xrayJson';
import { generatedTag } from './tags';
import type { RuleNodeData } from './types';

/** A node preview is a config fragment, not another whole-graph export. */
export function dnsContextPreview(config: Record<string, unknown>, data: RuleNodeData, id: string) {
  const dns = jsonRecord(config.dns) ? config.dns : {};
  if (data.kind === 'dns-handler') {
    const settings = Object.fromEntries(Object.entries(dns).filter(([key]) => key !== 'servers'));
    return {
      dns: settings,
      outbounds: (jsonArray(config.outbounds) ? config.outbounds : []).filter(
        (outbound) => jsonRecord(outbound) && outbound.tag === data.settings.tag,
      ),
    };
  }
  const servers = jsonArray(dns.servers) ? dns.servers : [];
  if (data.kind === 'dns-servers') {
    const entries = parseJson(String(data.settings.servers));
    const tags = new Set(
      (jsonArray(entries) ? entries : [])
        .filter(jsonRecord)
        .map((server) => generatedTag('wds', id, String(server.id))),
    );
    const routing = jsonRecord(config.routing) ? config.routing : {};
    return {
      dns: {
        servers: servers.filter((server) => jsonRecord(server) && tags.has(String(server.tag))),
      },
      routing: {
        rules: (jsonArray(routing.rules) ? routing.rules : []).filter(
          (rule) =>
            jsonRecord(rule) &&
            jsonArray(rule.inboundTag) &&
            rule.inboundTag.some((tag) => tags.has(String(tag))),
        ),
      },
    };
  }
  return {
    dns: Object.fromEntries(
      ['servers', 'disableFallback', 'disableFallbackIfMatch', 'enableParallelQuery']
        .filter((key) => dns[key] !== undefined)
        .map((key) => [key, dns[key]]),
    ),
  };
}

export function policyContextPreview(config: Record<string, unknown>, groupTag?: string) {
  const observation = jsonRecord(config.observation) ? config.observation : config;
  const result: Record<string, unknown> = Object.fromEntries(
    ['observatory', 'burstObservatory']
      .filter((key) => observation[key] !== undefined)
      .map((key) => [key, observation[key]]),
  );
  if (groupTag) {
    const routing = jsonRecord(config.routing) ? config.routing : config;
    result.routing = {
      balancers: (jsonArray(routing.balancers) ? routing.balancers : []).filter(
        (balancer) => jsonRecord(balancer) && balancer.tag === groupTag,
      ),
    };
  }
  return result;
}

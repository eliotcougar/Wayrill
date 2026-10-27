import { NAT_ROUTING_TAG } from './tun';
import { captureRuleVariants, projectNativeRule, type TableRule } from './rules';
import { isDisabledInbound } from './inboundState';
import type { routingPaths } from './routingPaths';
import type { GraphState, RuleNode } from './types';

/** Forwarded clients have a recovered source, but no host application/account identity. */
export function natRuleVariants(row: TableRule, inputTags?: string[]): Record<string, unknown>[] {
  return captureRuleVariants(row, 'capture')
    .map((variant) => projectNativeRule(row, variant))
    .filter(
      (variant) =>
        !['_wayrillApplications', 'process', 'user', 'localOS'].some((key) =>
          Object.hasOwn(variant, key),
        ),
    )
    .flatMap((variant) => {
      if (!inputTags || !Array.isArray(variant.inboundTag)) return [variant];
      return variant.inboundTag.some((tag) => inputTags.includes(String(tag)))
        ? [{ ...variant, inboundTag: [NAT_ROUTING_TAG] }]
        : [];
    });
}

export function compileNatRouting(
  graph: GraphState,
  paths: ReturnType<typeof routingPaths>,
  terminal: (node: RuleNode, allowDns: boolean) => Record<string, string>,
  warnings: string[],
): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];
  for (const input of graph.nodes.filter(
    (node) => node.data.kind === 'tun-inbound' && !isDisabledInbound(node.data),
  )) {
    const separate = input.data.settings.separateNatTraffic === true;
    const dataPort = separate ? 'nat-data' : 'traffic',
      dnsPort = separate ? 'nat-dns' : 'dns';
    const project = (node: RuleNode, row: TableRule) => {
      const variants = natRuleVariants(row, [
        String(input.data.settings.tag),
        typeof input.data.native?.original.tag === 'string' ? input.data.native.original.tag : '',
      ]);
      if (natRuleVariants(row).length !== captureRuleVariants(row, 'capture').length)
        warnings.push(
          `${node.data.label}: ${row.name} — host application and account conditions do not match Windows NAT traffic.`,
        );
      // This branch is a derived copy; keep an imported ruleTag on its original
      // host rule only. The routing trace still identifies the editor's rule.
      return variants.map((variant) => {
        const fields = { ...variant };
        delete fields.ruleTag;
        return fields;
      });
    };
    if (graph.edges.some((edge) => edge.source === input.id && edge.sourceHandle === dnsPort))
      rules.push(
        ...paths.expand(
          paths.connected(input, dnsPort),
          { inboundTag: [NAT_ROUTING_TAG], network: 'tcp,udp', port: '53' },
          { terminal: (node) => terminal(node, true), project },
        ),
      );
    rules.push(
      ...paths.expand(
        paths.connected(input, dataPort),
        { inboundTag: [NAT_ROUTING_TAG] },
        { terminal: (node) => terminal(node, false), project },
      ),
    );
  }
  return rules;
}

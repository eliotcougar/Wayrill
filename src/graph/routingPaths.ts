import {
  intersectPredicates as intersect,
  routingPredicateKeys as predicates,
} from '@wayrill/core/routingPredicates';
import {
  setRoutingInput,
  setRoutingTrace,
  type RoutingHop,
  type RoutingInput,
} from './routingTrace';
import { LIMITS } from '../limits';
import { readRuleTable, routingRuleVariants, type TableRule } from './rules';
import { jsonArray } from './xrayJson';
import type { GraphState, RuleNode } from './types';

type Fields = Record<string, unknown>;
export class RoutingPathError extends Error {
  constructor(
    public nodeId: string,
    message: string,
    public fieldKey = 'ruleTable',
  ) {
    super(message);
  }
}
export const intersectPredicates = (a: Fields, b: Fields): Fields | null =>
  intersect(a, b, LIMITS.maxPredicateTerms);

export function routingPaths(graph: GraphState, initialRules = 0) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n])),
    edges = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const key = `${edge.source}\0${edge.sourceHandle}`;
    edges.set(key, [...(edges.get(key) ?? []), edge.target]);
  }
  const connected = (node: RuleNode, port: string) => {
    const targets = edges.get(`${node.id}\0${port}`) ?? [],
      target = targets.length === 1 && byId.get(targets[0]);
    if (!target)
      throw new RoutingPathError(
        node.id,
        `${node.data.label}: Connect the ${port} output to exactly one destination.`,
      );
    return target;
  };
  let visits = 0,
    emitted = initialRules;
  const warnings: string[] = [];
  let defaultTrace: RoutingHop[] | undefined;
  function expand(
    start: RuleNode,
    scope: Fields,
    options: {
      terminal: (node: RuleNode) => Fields;
      input?: RoutingInput;
      /** A separate authenticated TUN identity follows only explicit ambiguity paths. */
      tunAmbiguity?: { blockTag: string };
      project?: (node: RuleNode, row: TableRule) => Fields | Fields[];
      rootFallback?: boolean;
      implicitFallbackId?: string;
      defaultType?: boolean;
      onRule?: (node: RuleNode, row: TableRule, fields: Fields) => void;
    },
  ): Fields[] {
    const rules: Fields[] = [],
      active = new Set<string>();
    const visit = (
      node: RuleNode,
      guard: Fields,
      root = false,
      entering = 'inbound scope',
      trail: RoutingHop[] = [],
    ) => {
      if (++visits > LIMITS.maxPathVisits)
        throw new RoutingPathError(
          node.id,
          `${node.data.label}: routing path expansion exceeds ${LIMITS.maxPathVisits} steps. Reduce repeated branches.`,
        );
      if (node.data.kind !== 'routing-filter') {
        if (node.id === options.implicitFallbackId && !Object.keys(guard).length) {
          defaultTrace = trail;
          return;
        }
        if (++emitted > LIMITS.maxRoutingRules)
          throw new RoutingPathError(
            node.id,
            `${node.data.label}: expanded routing exceeds ${LIMITS.maxRoutingRules} rules.`,
          );
        rules.push(
          setRoutingTrace(
            {
              ...(options.defaultType === false ? {} : { type: 'field' }),
              ...guard,
              ...options.terminal(node),
            },
            trail,
          ),
        );
        return;
      }
      if (active.has(node.id))
        throw new RoutingPathError(node.id, `${node.data.label}: routing filter cycle detected.`);
      active.add(node.id);
      const table = readRuleTable(node.data.settings);
      if (options.tunAmbiguity) {
        const policy = table.tunAmbiguity;
        const outputId = policy?.output || table.defaultOutput;
        const output = table.outputs.find((o) => o.id === outputId)?.name ?? outputId;
        const hop: RoutingHop = {
          filterId: node.id,
          ruleId: null,
          rule: 'Ambiguous TUN ownership',
          outputId: policy?.action === 'allow' ? outputId : '',
          output: policy?.action === 'allow' ? output : 'Block',
        };
        if (policy?.action === 'allow') {
          visit(
            connected(node, outputId),
            guard,
            false,
            `${node.data.label} / Ambiguous TUN ownership`,
            [...trail, hop],
          );
        } else {
          if (++emitted > LIMITS.maxRoutingRules)
            throw new RoutingPathError(node.id, 'Ambiguous TUN routing exceeds the rule limit.');
          rules.push(
            setRoutingTrace(
              { type: 'field', ...guard, outboundTag: options.tunAmbiguity.blockTag },
              [...trail, hop],
            ),
          );
        }
        active.delete(node.id);
        return;
      }
      let matchedAll = false;
      for (const row of table.rules.filter((r) => r.enabled)) {
        const projection = options.project?.(node, row) ?? routingRuleVariants(row);
        const variants = jsonArray(projection) ? projection : [projection];
        if (!variants.length) continue;
        const child = connected(node, row.output);
        for (const projected of variants) {
          if (child.data.kind === 'routing-filter') {
            const extra = Object.keys(projected).filter(
              (k) =>
                !predicates.has(k) &&
                !['type', 'domainMatcher', 'outboundTag', 'balancerTag'].includes(k),
            );
            if (extra.length)
              throw new RoutingPathError(
                node.id,
                `${node.data.label}: ${row.name} has native ${extra.join(', ')} metadata that cannot be expanded across a child filter.`,
              );
          }
          const fields = { ...projected };
          delete fields.outboundTag;
          delete fields.balancerTag;
          let intersection: Fields | null;
          try {
            intersection = intersectPredicates(guard, fields);
          } catch (e) {
            throw new RoutingPathError(
              node.id,
              `${node.data.label}: ${row.name} cannot combine its predicate with the path from ${entering} (${(e as Error).message}). Use different fields, identical opaque predicates, or compatible full/domain names and literal IP ranges.`,
            );
          }
          if (intersection) {
            options.onRule?.(node, row, fields);
            const output = table.outputs.find((o) => o.id === row.output)?.name ?? row.output;
            visit(child, intersection, false, `${node.data.label} / ${row.name} → ${output}`, [
              ...trail,
              { filterId: node.id, ruleId: row.id, rule: row.name, outputId: row.output, output },
            ]);
          } else
            warnings.push(
              `${node.data.label}: ${row.name} cannot match the path from ${entering} (${JSON.stringify(guard)}); its predicates are disjoint. Other entering paths may still match.`,
            );
        }
        if (row.matchAll) {
          matchedAll = true;
          break;
        }
      }
      if (!matchedAll && (!root || options.rootFallback !== false))
        visit(
          connected(node, table.defaultOutput),
          guard,
          false,
          `${node.data.label} / Unmatched traffic`,
          [
            ...trail,
            {
              filterId: node.id,
              ruleId: null,
              rule: 'Unmatched traffic',
              outputId: table.defaultOutput,
              output:
                table.outputs.find((o) => o.id === table.defaultOutput)?.name ??
                table.defaultOutput,
            },
          ],
        );
      active.delete(node.id);
    };
    visit(start, scope, true);
    return rules.map((rule) => setRoutingInput(rule, options.input));
  }
  return {
    connected,
    expand,
    warnings,
    get defaultTrace() {
      return defaultTrace;
    },
  };
}

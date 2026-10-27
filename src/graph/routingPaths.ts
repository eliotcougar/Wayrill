import { setRoutingTrace, type RoutingHop } from './routingTrace';
import { LIMITS } from '../limits';
import { intersectNativeProcesses, intersectProtocolPrefixes } from './nativePredicates';
import {
  effectiveRoutingFields,
  readRuleTable,
  routingRuleVariants,
  type TableRule,
} from './rules';
import { jsonEqual, jsonText, jsonArray } from './xrayJson';
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
const sets = new Set(['inboundTag', 'user', 'protocol', 'process', 'localOS']);
const ports = new Set(['port', 'sourcePort', 'localPort', 'vlessRoute']);
const ips = new Set(['ip', 'sourceIP', 'localIP']);
const predicates = new Set([
  ...sets,
  ...ports,
  ...ips,
  'domain',
  'domains',
  'source',
  'network',
  'attrs',
  '_wayrillApplications',
]);
const array = (v: unknown): string[] => (jsonArray(v) ? v.map(String) : [String(v)]);
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));
function ranges(v: unknown): [number, number][] {
  return String(v)
    .split(',')
    .map((s) => {
      const [a, b = a] = s.trim().split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > 65535 || a > b)
        throw new Error('Invalid range in a routing predicate.');
      return [a, b];
    });
}
function intersectRanges(a: unknown, b: unknown): string | null {
  const intersections: [number, number][] = [];
  for (const [al, ah] of ranges(a))
    for (const [bl, bh] of ranges(b)) {
      const low = Math.max(al, bl),
        high = Math.min(ah, bh);
      if (low <= high) intersections.push([low, high]);
    }
  intersections.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const range of intersections) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged.length
    ? merged.map(([l, h]) => (l === h ? String(l) : `${l}-${h}`)).join(',')
    : null;
}
function domain(text: string): { kind: 'full' | 'domain'; value: string } | undefined {
  const match = /^(full|domain):(.+)$/.exec(text);
  return match ? { kind: match[1] as 'full' | 'domain', value: match[2].toLowerCase() } : undefined;
}
function suffix(name: string, parent: string) {
  return name === parent || name.endsWith(`.${parent}`);
}
// Each list is OR; a path is AND. Never turn (A OR B) AND (C OR D) into a union.
function intersectLists(a: string[], b: string[], field: string): string[] | null {
  if (sameSet(a, b)) return a;
  const result = new Set<string>();
  for (const x of a)
    for (const y of b) {
      if (x === y) result.add(x);
      else if (ips.has(field)) {
        const sx = subnet(x),
          sy = subnet(y);
        if (!sx || !sy) throw new Error('Opaque GeoIP or negated IP predicates');
        if (sx.family === sy.family && sx.low <= sy.high && sy.low <= sx.high)
          result.add(sx.low >= sy.low && sx.high <= sy.high ? x : y);
      } else {
        const dx = domain(x),
          dy = domain(y);
        if (!dx || !dy) throw new Error('Opaque domain, regexp, keyword or geosite predicates');
        if (dx.kind === 'full' && dy.kind === 'full') {
          if (dx.value === dy.value) result.add(x);
        } else if (dx.kind === 'full') {
          if (suffix(dx.value, dy.value)) result.add(x);
        } else if (dy.kind === 'full') {
          if (suffix(dy.value, dx.value)) result.add(y);
        } else if (suffix(dx.value, dy.value)) result.add(x);
        else if (suffix(dy.value, dx.value)) result.add(y);
      }
      if (result.size > LIMITS.maxPredicateTerms)
        throw new Error('Predicate expansion exceeds its term budget');
    }
  return result.size ? [...result] : null;
}
export function intersectPredicates(a: Fields, b: Fields): Fields | null {
  // A native alias must not override a parent condition after flattening. Keep
  // untouched root rules exact; canonicalize only when combining that predicate.
  if (
    [
      ['domain', 'domains'],
      ['sourceIP', 'source'],
    ].some(
      (keys) =>
        keys.some((key) => Object.hasOwn(a, key)) && keys.some((key) => Object.hasOwn(b, key)),
    )
  ) {
    a = effectiveRoutingFields(a);
    b = effectiveRoutingFields(b);
    for (const fields of [a, b]) {
      delete fields.domains;
      delete fields.source;
    }
  }
  const result = { ...a };
  const empty = (v: unknown) => v === null || (jsonArray(v) && !v.length);
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(result, key)) {
      result[key] = value;
      continue;
    }
    // Empty native matcher lists add no condition in Xray. Their conjunction is
    // the other predicate, rather than an empty intersection that drops a path.
    if (predicates.has(key) && empty(value)) continue;
    const old = result[key];
    if (predicates.has(key) && empty(old)) {
      result[key] = value;
      continue;
    }
    if (jsonEqual(old, value)) continue;
    if (key === '_wayrillApplications')
      result[key] = [...new Set([...array(old), ...array(value)])];
    else if (ports.has(key)) result[key] = intersectRanges(old, value);
    else if (key === 'process') result[key] = intersectNativeProcesses(array(old), array(value));
    else if (key === 'protocol') result[key] = intersectProtocolPrefixes(array(old), array(value));
    else if (sets.has(key) || key === 'network') {
      const lhs =
          key === 'network'
            ? String(old)
                .split(',')
                .map((v) => v.trim())
            : array(old),
        rhs =
          key === 'network'
            ? jsonText(value)
                .split(',')
                .map((v) => v.trim())
            : array(value),
        overlap = lhs.filter((v) =>
          rhs.some((r) => (key === 'localOS' ? r.toLowerCase() === v.toLowerCase() : r === v)),
        );
      result[key] = overlap.length ? (key === 'network' ? overlap.join(',') : overlap) : null;
    } else if (ips.has(key) || key === 'domain')
      result[key] = intersectLists(array(old), array(value), key);
    else if (key === 'attrs') {
      const attributes = { ...(old as Fields) };
      for (const [name, pattern] of Object.entries(value as Fields)) {
        if (Object.hasOwn(attributes, name) && !jsonEqual(attributes[name], pattern))
          throw new Error(`Different expressions for HTTP attribute ${name}`);
        attributes[name] = pattern;
      }
      result[key] = attributes;
    } else throw new Error(`Different native ${key} values`);
    if (result[key] === null) return null;
  }
  return result;
}

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
    return rules;
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
import { subnet } from './ipNetwork';

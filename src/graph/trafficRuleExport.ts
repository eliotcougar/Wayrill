import { portableTrafficRule } from '../portableJson';
import { jsonArray } from './xrayJson';
import type { GraphState, RuleNode } from './types';
import {
  captureRuleFields,
  effectiveRoutingFields,
  projectNativeRule,
  readRuleTable,
  tableSettings,
  type RuleTable,
} from './rules';

export const trafficRulesFormat = 'wayrill.rules';
export const indentedJson = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** Embedding makes an independent snapshot; otherwise keep the editable source/override model. */
export function exportWayrillRules(table: RuleTable, name: string, embedOverrides = false): string {
  readRuleTable(tableSettings(table));
  return indentedJson({
    format: trafficRulesFormat,
    version: 1,
    kind: 'traffic',
    name,
    outputs: table.outputs,
    rules: table.rules.map(({ source, ...rule }) =>
      portableTrafficRule({ ...rule, ...(!embedOverrides && source ? { source } : {}) }, 'write'),
    ),
    ...(!embedOverrides && table.source ? { source: table.source } : {}),
    defaultOutput: table.defaultOutput,
    ...(table.tunAmbiguity ? { tunAmbiguity: table.tunAmbiguity } : {}),
  });
}

export function readWayrillRules(value: Record<string, unknown>): RuleTable {
  if (value.version !== 1 || value.kind !== 'traffic')
    throw new Error('Unsupported Wayrill rules format.');
  if (!jsonArray(value.rules)) throw new Error('Wayrill rules must be an array.');
  return readRuleTable({
    outputs: JSON.stringify(value.outputs),
    rules: JSON.stringify(value.rules.map((rule) => portableTrafficRule(rule, 'read'))),
    defaultOutput: typeof value.defaultOutput === 'string' ? value.defaultOutput : '',
    ...(value.tunAmbiguity === undefined
      ? {}
      : { tunAmbiguity: JSON.stringify(value.tunAmbiguity) }),
    ...(value.source === undefined ? {} : { ruleSource: JSON.stringify(value.source) }),
  });
}

export function compatibleOutput(
  table: RuleTable,
  graph: GraphState,
  node: RuleNode,
  outputId: string,
) {
  const output = table.outputs.find((o) => o.id === outputId);
  const target = graph.nodes.find(
    (n) =>
      n.id === graph.edges.find((e) => e.source === node.id && e.sourceHandle === outputId)?.target,
  );
  const fixed =
    target?.data.kind === 'direct-outbound'
      ? 'direct'
      : target?.data.kind === 'block-outbound'
        ? 'block'
        : (target && target.id === graph.mainOutboundId) ||
            output?.name.trim().toLowerCase() === 'main'
          ? 'proxy'
          : '';
  return {
    fixed,
    name: fixed || target?.data.label || output?.name || '',
  };
}

const supported = new Set(['domain', 'ip', 'process', 'port', 'network', 'protocol', 'inboundTag']);
const routingMetadata = new Set(['type', 'outboundTag', 'balancerTag', 'ruleTag']);
const targets = ['domain', 'ip', 'process'];
export interface CompatibleExport {
  text: string;
  count: number;
  omitted: string[];
}

/** Stock v2rayN ORs the destination/process fields and ANDs the common predicates. */
export function exportCompatibleRules(
  table: RuleTable,
  destinations: Record<string, string>,
): CompatibleExport {
  readRuleTable(tableSettings(table));
  const rows: Record<string, unknown>[] = [],
    omitted: string[] = [];
  const destination = (output: string) => {
    const tag = destinations[output]?.trim();
    if (!tag || tag.length > 256 || [...tag].some((c) => c.charCodeAt(0) < 32))
      throw new Error('Give every output a valid v2rayN outbound name (up to 256 characters).');
    return tag;
  };
  for (const output of table.outputs) destination(output.id);
  for (const [index, rule] of table.rules.entries()) {
    const label = rule.name || `Rule ${index + 1}`;
    try {
      const applications = rule.applications?.filter((app) => app.enabled) ?? [];
      const plain = applications.filter((app) => app.kind === 'process' && !app.children);
      const unavailable = applications.length - plain.length;
      if (!rule.matchAll && unavailable && rule.targetMatch === 'all')
        throw new Error('requires Windows apps, services or child-process tracking');
      // Keep representable OR alternatives; never weaken a required AND predicate.
      const fields = effectiveRoutingFields(projectNativeRule(rule, captureRuleFields(rule)));
      if (!rule.matchAll && unavailable) {
        delete fields._wayrillApplications;
        const processes = [
          ...(jsonArray(fields.process) ? fields.process : []),
          ...plain.map((app) =>
            app.mode === 'folder' ? app.value.replace(/[\\/]?$/, '/') : app.value,
          ),
        ];
        if (processes.length) fields.process = [...new Set(processes)];
        else delete fields.process;
      }
      delete fields.domains;
      delete fields.source;
      const unsupported = Object.keys(fields).filter(
        (key) => !supported.has(key) && !routingMetadata.has(key),
      );
      if (unsupported.length) throw new Error(`unsupported conditions: ${unsupported.join(', ')}`);
      const activeTargets = targets.filter((key) => jsonArray(fields[key]) && fields[key].length);
      if (!rule.matchAll && unavailable) {
        if (!activeTargets.length)
          throw new Error('no compatible destination or process selectors remain');
        omitted.push(
          `${label}: omitted ${unavailable} Windows app, service or child-process selector(s).`,
        );
      }
      if (rule.targetMatch === 'all' && activeTargets.length > 1)
        throw new Error(
          'requires destination/process conditions together; v2rayN treats them as alternatives',
        );
      const predicates = Object.fromEntries(
        Object.entries(fields).filter(([key]) => supported.has(key)),
      );
      if (!Object.keys(predicates).length) throw new Error('has no compatible conditions');
      rows.push({
        type: 'field',
        ...predicates,
        outboundTag: destination(rule.output),
        enabled: rule.enabled,
        remarks: rule.name,
      });
    } catch (error) {
      omitted.push(
        `${label}: skipped — ${error instanceof Error ? error.message : 'unsupported rule'}.`,
      );
    }
  }
  rows.push({
    type: 'field',
    network: 'tcp,udp',
    outboundTag: destination(table.defaultOutput),
    enabled: true,
    remarks: 'Unmatched traffic',
  });
  if (table.tunAmbiguity?.action === 'allow')
    omitted.push('Ambiguous TUN ownership policy is not supported by v2rayN.');
  return { text: indentedJson(rows), count: rows.length, omitted };
}

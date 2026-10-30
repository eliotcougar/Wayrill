import { boundedText } from '../text';
import { LIMITS } from '../limits';
import { parseXrayJson, jsonRecord, jsonText, jsonArray } from './xrayJson';
import { parseApplicationSelectors, type ApplicationSelector } from './applications';
import { readWayrillRules, trafficRulesFormat } from './trafficRuleExport';
import { remapTrafficSource } from './ruleSourceRemap';
import type { RuleSource } from './ruleSourceModel';
import {
  bindOutputs,
  newPresetOutput,
  type PresetBindings,
  type PresetMode,
} from './routingPresets';
import {
  routingConditionFields,
  tableSettings,
  ruleTableProblems,
  type RuleTable,
  type TableRule,
} from './rules';

export interface ImportedTrafficRules {
  format?: 'wayrill';
  rules: (Omit<TableRule, 'id'> & { sourceId?: string; sourceName?: boolean })[];
  source?: RuleSource;
  roles: { id: string; name: string; tag: string; kind: 'outbound' | 'balancer' }[];
  defaultOutput?: string;
  domainStrategy?: string;
  tunAmbiguity?: RuleTable['tunAmbiguity'];
  notes: string[];
  sourceRules: number;
}
const fields = [
  ...routingConditionFields.map((f) => f.key),
  'type',
  'outboundTag',
  'balancerTag',
  'enabled',
  'remarks',
  'id',
  'ruleType',
  'blocks',
];
function names(value: unknown, keys: string[], context: string): Record<string, unknown> {
  if (!jsonRecord(value)) throw new Error(`${context} must be an object.`);
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const canonical = keys.find((k) => k.toLowerCase() === key.toLowerCase()) ?? key;
    if (Object.hasOwn(result, canonical))
      throw new Error(`${context}: conflicting spellings of ${canonical}.`);
    result[canonical] = v;
  }
  return result;
}
function known(value: Record<string, unknown>, keys: string[], context: string) {
  for (const [key, v] of Object.entries(value))
    if (!keys.includes(key) && v !== null && v !== undefined)
      throw new Error(`${context}: unsupported field ${key}.`);
}
function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}
function strings(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!jsonArray(value) || value.some((v) => typeof v !== 'string' || /[\r\n\0]/.test(v)))
    throw new Error(`${label} must be an array of single-line strings.`);
  return value as string[];
}
function text(value: unknown, label: string): string {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 16384 || value.includes('\0'))
    throw new Error(`${label} must be text (at most 16,384 characters).`);
  return value;
}
const selectors = [
  'domain',
  'ip',
  'port',
  'process',
  'windowsApp',
  'protocol',
  'inboundTag',
  'network',
  'service',
];
function enumValue(value: unknown, options: string[], label: string): number {
  const index =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? options.findIndex((v) => v.toLowerCase() === value.toLowerCase())
        : -1;
  if (!Number.isInteger(index) || index < 0 || index >= options.length)
    throw new Error(`${label} is unsupported.`);
  return index;
}
function blockFields(raw: unknown, label: string) {
  const block = names(raw, ['version', 'enabled', 'filters'], label);
  known(block, ['version', 'enabled', 'filters'], label);
  if (block.version !== undefined && block.version !== 1)
    throw new Error(`${label}: unsupported block version.`);
  if (!jsonArray(block.filters) || !block.filters.length || block.filters.length > selectors.length)
    throw new Error(`${label}: expected nonempty filters.`);
  const conditions: Record<string, string> = {},
    applications: ApplicationSelector[] = [],
    seen = new Set<number>();
  for (const rawFilter of block.filters) {
    const filter = names(rawFilter, ['selector', 'values', 'applications'], label);
    known(filter, ['selector', 'values', 'applications'], label);
    const selector = enumValue(filter.selector, selectors, `${label} selector`),
      key = selectors[selector];
    if (seen.has(selector)) throw new Error(`${label}: duplicate ${key} filter.`);
    seen.add(selector);
    if (['process', 'windowsApp', 'service'].includes(key)) {
      const kind = key === 'windowsApp' ? 'package' : (key as 'process' | 'service');
      const rows =
        filter.applications == null
          ? strings(filter.values, `${label} ${key}`).map((value) => ({ value }))
          : filter.applications;
      if (!jsonArray(rows) || !rows.length) throw new Error(`${label}: empty ${key} selector.`);
      for (const rawRow of rows) {
        const row = names(rawRow, ['value', 'mode', 'enabled', 'includeChildren'], label);
        known(row, ['value', 'mode', 'enabled', 'includeChildren'], label);
        let value = text(row.value, label).trim().replace(/^"|"$/g, '').replaceAll('\\', '/');
        const inferred = value.endsWith('/') ? 1 : value.includes('/') ? 0 : 2;
        const mode = enumValue(
          row.mode ?? inferred,
          ['fullPath', 'folder', 'name'],
          `${label} process mode`,
        );
        if (kind === 'process') {
          if (mode === 2) value = value.split('/').at(-1)!;
          if (mode === 1 && !value.endsWith('/'))
            value = /\.exe$/i.test(value)
              ? value.slice(0, value.lastIndexOf('/') + 1)
              : value + '/';
        }
        applications.push({
          kind,
          value,
          mode:
            kind === 'process'
              ? (['path', 'folder', 'name'][mode] as ApplicationSelector['mode'])
              : 'name',
          enabled: boolean(row.enabled, true, label),
          children: boolean(row.includeChildren, false, label),
        });
      }
    } else {
      if (filter.applications != null)
        throw new Error(`${label}: application rows require a process, app or service selector.`);
      const values = strings(filter.values, `${label} ${key}`).filter(
        (v) => !['domain', 'ip'].includes(key) || !v.startsWith('#'),
      );
      if (!values.length) throw new Error(`${label}: empty ${key} selector.`);
      conditions[key] = values
        .map((v) => (key === 'domain' ? v.replaceAll('<COMMA>', ',') : v))
        .join(['port', 'network'].includes(key) ? ',' : '\n');
    }
  }
  parseApplicationSelectors(applications);
  return { conditions, applications, enabled: boolean(block.enabled, true, label) };
}

/** v2rayN lists use destination/application OR; native Xray routing objects use AND. */
export function parseTrafficRules(textValue: string): ImportedTrafficRules {
  const parsed = parseXrayJson(textValue);
  if (jsonRecord(parsed) && parsed.format === trafficRulesFormat) {
    const table = readWayrillRules(parsed);
    return {
      format: 'wayrill',
      rules: table.rules.map(({ id, ...rule }) => ({ ...rule, sourceId: id, sourceName: true })),
      roles: table.outputs.map((output) => ({ ...output, tag: output.name, kind: 'outbound' })),
      defaultOutput: table.defaultOutput,
      ...(table.source ? { source: table.source } : {}),
      ...(table.tunAmbiguity ? { tunAmbiguity: table.tunAmbiguity } : {}),
      notes: table.source
        ? ['Replace can retain the saved source and overrides; Append uses the effective rules.']
        : [],
      sourceRules: table.rules.length,
    };
  }
  let rawRules: unknown = parsed,
    native = false,
    domainStrategy: unknown;
  if (jsonRecord(parsed)) {
    const root = names(
      parsed,
      ['routing', 'rules', 'ruleSet', 'domainStrategy'],
      'Routing document',
    );
    let section = root;
    if (root.routing !== undefined) {
      section = names(root.routing, ['rules', 'domainStrategy'], 'Routing');
      native = true;
    }
    if (section.ruleSet !== undefined)
      rawRules =
        typeof section.ruleSet === 'string' ? parseXrayJson(section.ruleSet) : section.ruleSet;
    else {
      rawRules = section.rules;
      native = true;
    }
    domainStrategy = section.domainStrategy;
  }
  if (!jsonArray(rawRules) || !rawRules.length)
    throw new Error('Choose a v2rayN rule list, RuleSet export or Xray routing object.');
  // A stock export can include 128 ordered rules plus a final catch-all.
  if (rawRules.length > 129) throw new Error('A traffic filter import supports at most 128 rules.');
  if (
    domainStrategy != null &&
    !['AsIs', 'IPIfNonMatch', 'IPOnDemand'].includes(jsonText(domainStrategy))
  )
    throw new Error('Unsupported routing domain strategy.');
  const result: ImportedTrafficRules = {
    rules: [],
    roles: [],
    notes: [],
    sourceRules: rawRules.length,
    ...(domainStrategy ? { domainStrategy: jsonText(domainStrategy) } : {}),
  };
  let skippedDns = 0;
  for (const [index, raw] of rawRules.entries()) {
    const label = `Rule ${index + 1}`,
      row = names(raw, fields, label);
    known(row, fields, label);
    if (row.ruleType != null) {
      const ruleType = enumValue(row.ruleType, ['all', 'routing', 'dns'], `${label} rule type`);
      if (ruleType === 2) {
        skippedDns++;
        continue;
      }
    }
    if (row.type != null && row.type !== '' && row.type !== 'field')
      throw new Error(`${label}: only field rules are supported.`);
    const outbound = text(row.outboundTag, `${label} outbound tag`),
      balancer = text(row.balancerTag, `${label} balancer tag`);
    if (outbound && balancer) throw new Error(`${label}: choose one destination type.`);
    const tag = balancer || outbound || (native ? '' : 'proxy');
    if (
      !tag.trim() ||
      tag.length > 256 ||
      [...tag].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error(`${label}: missing or invalid destination tag.`);
    const kind = balancer ? 'balancer' : 'outbound',
      output = `${kind}:${tag}`;
    if (!result.roles.some((r) => r.id === output))
      result.roles.push({ id: output, tag, kind, name: boundedText(tag, 64) });
    let conditions: Record<string, string> = {},
      applications: ApplicationSelector[] | undefined;
    let enabled = boolean(row.enabled, true, `${label} enabled`);
    if (row.blocks != null) {
      if (native) throw new Error(`${label}: v2rayN Blocks require a v2rayN rule list.`);
      const block = blockFields(row.blocks, label);
      conditions = block.conditions;
      applications = block.applications;
      enabled = block.enabled;
    } else {
      for (const field of routingConditionFields) {
        const value = row[field.key];
        if (value == null) continue;
        if (field.list) {
          let values = strings(value, `${label} ${field.key}`);
          if (!native && ['domain', 'ip'].includes(field.key))
            values = values
              .filter((v) => !v.startsWith('#'))
              .map((v) => (field.key === 'domain' ? v.replaceAll('<COMMA>', ',') : v));
          conditions[field.key] = values.join('\n');
        } else if (field.key === 'attrs') {
          if (!jsonRecord(value) || Object.values(value).some((v) => typeof v !== 'string'))
            throw new Error(`${label}: attrs must contain string values.`);
          conditions.attrs = JSON.stringify(value);
        } else conditions[field.key] = text(value, `${label} ${field.key}`);
      }
    }
    if (conditions.network) {
      const networks = [...new Set(conditions.network.split(',').map((value) => value.trim()))];
      if (networks.every((value) => value === 'tcp' || value === 'udp'))
        conditions.network = networks.sort().join(',');
    }
    if (Object.values(conditions).some((v) => v.length > 16384))
      throw new Error(`${label}: a condition exceeds 16,384 characters.`);
    const active = Object.entries(conditions).filter(([, v]) => v.trim());
    const matchAll =
      !applications?.length &&
      active.every(
        ([k, v]) => (k === 'port' && v === '0-65535') || (k === 'network' && v === 'tcp,udp'),
      );
    const rule: ImportedTrafficRules['rules'][number] = {
      name: boundedText(text(row.remarks, `${label} name`).trim(), 128) || label,
      enabled,
      output,
      conditions,
      targetMatch: native ? 'all' : 'any',
      matchAll,
      ...(applications?.length ? { applications } : {}),
      ...(typeof row.id === 'string' && row.id.trim()
        ? { sourceId: text(row.id, `${label} ID`) }
        : {}),
      sourceName: !!text(row.remarks, `${label} name`).trim(),
    };
    // Legacy v2rayN skips empty rows and selectors that contain comments only.
    if (!native && row.blocks == null) {
      const hadTargets = ['domain', 'ip', 'process'].some(
        (k) => jsonArray(row[k]) && row[k].length,
      );
      const hasTargets = ['domain', 'ip', 'process'].some((k) => conditions[k]?.trim());
      if (!active.length || (hadTargets && !hasTargets)) rule.enabled = false;
    }
    result.rules.push(rule);
  }
  if (!result.rules.length) throw new Error('This file contains no traffic routing rules.');
  let last = result.rules.length - 1;
  while (last >= 0 && !result.rules[last].enabled) last--;
  if (last >= 0 && result.rules[last].matchAll) {
    result.defaultOutput = result.rules[last].output;
    result.rules.splice(last, 1);
    result.notes.push('Final catch-all moved to Unmatched traffic.');
  } else result.notes.push('No final catch-all: the current Unmatched traffic output is kept.');
  if (result.rules.length > 128)
    throw new Error('A traffic filter import supports at most 128 rules.');
  if (skippedDns)
    result.notes.push(`${skippedDns} DNS-only rule(s) omitted from this traffic import.`);
  const preview = {
    outputs: result.roles.map((r) => ({ id: `role-${result.roles.indexOf(r)}`, name: r.name })),
    rules: result.rules.map((r, i) => ({
      ...r,
      id: `rule-${i}`,
      output: `role-${result.roles.findIndex((o) => o.id === r.output)}`,
    })),
    defaultOutput: 'role-0',
  };
  const issues = ruleTableProblems({
    kind: 'routing-filter',
    settings: tableSettings(preview),
  } as Parameters<typeof ruleTableProblems>[0]).filter((i) => i.severity === 'error');
  // Display names can coincide across destination namespaces; binding creates unique output names.
  const problem = issues.find((i) => !i.outputId);
  if (problem) throw new Error(problem.message);
  return result;
}

export function rolesForTrafficImport(source: ImportedTrafficRules, mode: PresetMode) {
  return source.roles.filter(
    (role) =>
      source.rules.some((rule) => rule.output === role.id) ||
      (mode === 'replace' && source.format === 'wayrill') ||
      (mode === 'replace' &&
        (role.id === source.defaultOutput || role.id === source.tunAmbiguity?.output)),
  );
}

export function importTrafficRules(
  table: RuleTable,
  source: ImportedTrafficRules,
  bindings: PresetBindings,
  mode: PresetMode,
  preserveSource = true,
): RuleTable {
  const { outputs, ids } = bindOutputs(
    table.outputs,
    rolesForTrafficImport(source, mode),
    bindings,
    (id, name) => ({ id, name }),
  );
  const savedSource = mode === 'replace' && preserveSource ? source.source : undefined;
  const imported = remapTrafficSource(
    {
      outputs,
      defaultOutput: table.defaultOutput,
      ...(savedSource ? { source: savedSource } : {}),
      rules: source.rules.map(
        ({ sourceId: _identity, sourceName: _named, source: provenance, ...r }) => ({
          ...structuredClone(r),
          id: crypto.randomUUID(),
          ...(savedSource && provenance ? { source: structuredClone(provenance) } : {}),
        }),
      ),
    },
    new Map(Object.entries(ids)),
  );
  const rows = imported.rules;
  const rules = mode === 'append' ? [...table.rules, ...rows] : rows;
  if (
    outputs.length > 128 ||
    rules.length > 128 ||
    new TextEncoder().encode(JSON.stringify(rules)).length > LIMITS.configBytes
  )
    throw new Error(
      'A traffic filter supports 128 outputs and 128 rules within the configuration size limit.',
    );
  return {
    ...table,
    ...(mode === 'replace' ? { source: imported.source } : {}),
    outputs,
    rules,
    defaultOutput:
      mode === 'replace' && source.defaultOutput ? ids[source.defaultOutput] : table.defaultOutput,
    ...(mode === 'replace' && source.tunAmbiguity
      ? {
          tunAmbiguity: {
            ...source.tunAmbiguity,
            output: source.tunAmbiguity.output ? ids[source.tunAmbiguity.output] : '',
          },
        }
      : {}),
  };
}

// Remove only untouched factory outputs when the import supplies a replacement
// fallback. Connected or user-edited outputs remain stable across rule imports.
export function trafficImportBase(
  table: RuleTable,
  source: ImportedTrafficRules,
  bindings: PresetBindings,
  mode: PresetMode,
  connected: boolean,
): RuleTable {
  const fresh =
    mode === 'replace' &&
    !!source.defaultOutput &&
    !connected &&
    !table.rules.length &&
    table.tunAmbiguity?.action !== 'allow' &&
    table.defaultOutput === 'default' &&
    table.outputs.length === 2 &&
    table.outputs.every(
      (output) =>
        (output.id === 'default' && output.name === 'Default') ||
        (output.id === 'preferred' && output.name === 'Preferred'),
    ) &&
    Object.values(bindings).every((id) => id === newPresetOutput);
  return fresh ? { ...table, outputs: [] } : table;
}

import { jsonText, jsonArray, jsonEqual, parseJson, patchProjection } from './xrayJson';
import { portRangeProblem } from './portRanges';
import {
  parseApplicationSelectors,
  nativeProcessSelectors,
  type ApplicationSelector,
} from './applications';
import { LIMITS } from '../limits';
import { ipProblem, domainProblem } from './addressValidation';
export { ipProblem, domainProblem } from './addressValidation';
import { parseNativeProjection } from './xrayProjection';
import {
  validateRuleSource,
  validateSourceRow,
  type SourceRow,
  type RuleSource,
} from './ruleSourceModel';
import type {
  NativeProjection,
  Diagnostic,
  NodeDefinition,
  RuleNodeData,
  SettingValue,
} from './types';

export const isRuleTableKind = (kind: string) => kind === 'routing-filter';
export interface NamedOutput {
  id: string;
  name: string;
}
export interface TableRule {
  id: string;
  name: string;
  enabled: boolean;
  output: string;
  matchAll: boolean;
  conditions: Record<string, string>;
  /** Native Xray rules retain AND; authored rules use domain/IP/application alternatives. */
  targetMatch?: 'any' | 'all';
  applications?: ApplicationSelector[];
  native?: NativeProjection;
  source?: SourceRow;
}
export interface RuleTable {
  outputs: NamedOutput[];
  rules: TableRule[];
  defaultOutput: string;
  tunAmbiguity?: { action: 'block' | 'allow'; output: string };
  source?: RuleSource;
}
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
  rule: TableRule,
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
export const detectedProtocols = [
  { value: 'http', label: 'HTTP' },
  { value: 'tls', label: 'TLS' },
  { value: 'quic', label: 'QUIC' },
  { value: 'bittorrent', label: 'BitTorrent' },
];
export const routingConditionFields = [
  {
    key: 'domain',
    label: 'Destination domains',
    hint: 'One per line: domain:example.net, full:example.net, keyword:example, regexp:…, geosite:…',
    list: true,
  },
  {
    key: 'ip',
    label: 'Destination IPs',
    hint: 'One per line: IP, CIDR, geoip:private, geoip:…, or !CIDR',
    list: true,
  },
  { key: 'port', label: 'Destination ports', hint: '443,80,1000-2000' },
  { key: 'network', label: 'Network', hint: 'TCP, UDP, or both' },
  {
    key: 'protocol',
    label: 'Detected protocols',
    hint: 'One per line: http, tls, quic, bittorrent. Requires traffic inspection.',
    list: true,
  },
  {
    key: 'sourceIP',
    label: 'Source IPs',
    hint: 'One IP, CIDR or GeoIP entry per line',
    list: true,
  },
  { key: 'sourcePort', label: 'Source ports', hint: '53,1000-2000' },
  { key: 'inboundTag', label: 'Source tags', hint: 'One tag per line', list: true },
  { key: 'user', label: 'User emails', hint: 'One account email per line', list: true },
  {
    key: 'process',
    label: 'Process names',
    hint: 'Executable names, absolute paths or folders. Child processes, Windows apps and services use TUN or WinDivert.',
    list: true,
  },
  { key: 'localIP', label: 'Local inbound IPs', hint: 'One IP or CIDR per line', list: true },
  { key: 'localPort', label: 'Local inbound ports', hint: '10808,10809' },
  { key: 'vlessRoute', label: 'VLESS route values', hint: 'Numeric values or ranges, 0–65535' },
  {
    key: 'localOS',
    label: 'Local operating systems',
    hint: 'One value per line. Requires core metadata.',
    list: true,
  },
  {
    key: 'attrs',
    label: 'HTTP attributes',
    hint: 'JSON object, e.g. {":method":"GET"}. Requires HTTP sniffing.',
  },
];
export const listEntries = (value: string) =>
  value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
/** Comments are whole lines, so regexp anchors and literal # characters stay intact. */
export function routingListEntries(value: string, key: string) {
  if (!['domain', 'ip', 'sourceIP', 'localIP'].includes(key)) return listEntries(value);
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const entry = line.replace(/^,+|,+$/g, '').trim();
      if (key === 'domain' && /^(regexp|keyword)\s*:/.test(entry))
        return entry.replace(/^(regexp|keyword)\s*:\s*/, '$1:');
      return entry.replace(/\s+/g, '');
    })
    .filter(Boolean);
}
export function normalizeRuleLists(rule: TableRule): TableRule {
  return {
    ...rule,
    conditions: Object.fromEntries(
      Object.entries(rule.conditions).map(([key, value]) => [
        key,
        routingConditionFields.find((f) => f.key === key)?.list
          ? value
              .split(/\r?\n/)
              .map((line) =>
                line.trim().startsWith('#')
                  ? line
                  : line
                      .trim()
                      .replace(/^,+|,+$/g, '')
                      .trim(),
              )
              .join('\n')
          : value,
      ]),
    ),
  };
}
export const ruleTableDefinitions: NodeDefinition[] = [
  {
    kind: 'routing-filter',
    title: 'Routing filter',
    group: 'Rules & filters',
    category: 'filter',
    summary: 'Ordered traffic routing rules with named output paths',
    defaults: {
      outputs: JSON.stringify([
        { id: 'preferred', name: 'Preferred' },
        { id: 'default', name: 'Default' },
      ]),
      rules: '[]',
      defaultOutput: 'default',
    },
    fields: [
      {
        key: 'outputs',
        label: 'Named outputs',
        type: 'json',
        jsonShape: 'array',
        maxLength: 65536,
      },
      {
        key: 'rules',
        label: 'Ordered rules',
        type: 'json',
        jsonShape: 'array',
        maxLength: LIMITS.configBytes,
      },
      { key: 'defaultOutput', label: 'Default output', type: 'text', maxLength: 128 },
      {
        key: 'ruleSource',
        label: 'Rule source',
        type: 'json',
        jsonShape: 'object',
        optional: true,
        maxLength: LIMITS.configBytes,
      },
      {
        key: 'tunAmbiguity',
        optional: true,
        label: 'Ambiguous TUN ownership',
        type: 'json',
        jsonShape: 'object',
        maxLength: 1024,
      },
    ],
  },
];

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !jsonArray(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length <= max;
export function readRuleTable(settings: Record<string, SettingValue>): RuleTable {
  const outputs: unknown = parseJson(String(settings.outputs));
  const rules: unknown = parseJson(String(settings.rules));
  if (
    !jsonArray(outputs) ||
    outputs.length < 1 ||
    outputs.length > 128 ||
    !jsonArray(rules) ||
    rules.length > LIMITS.maxRoutingRules
  )
    throw new Error(`Use 1–128 outputs and at most ${LIMITS.maxRoutingRules} rules.`);
  const ids = new Set<string>();
  for (const output of outputs) {
    if (!record(output) || !id(output.id) || ids.has(output.id) || !text(output.name, 64))
      throw new Error('Invalid or duplicate output.');
    ids.add(output.id);
  }
  if (!ids.has(String(settings.defaultOutput)))
    throw new Error('Choose an existing default output.');
  const tunAmbiguity =
    settings.tunAmbiguity === undefined ? undefined : parseJson(String(settings.tunAmbiguity));
  if (
    tunAmbiguity !== undefined &&
    (!record(tunAmbiguity) ||
      (tunAmbiguity.action !== 'block' && tunAmbiguity.action !== 'allow') ||
      typeof tunAmbiguity.output !== 'string' ||
      (tunAmbiguity.output !== '' && !ids.has(tunAmbiguity.output)))
  )
    throw new Error('Choose an existing output for ambiguous TUN ownership.');
  const ruleIds = new Set<string>();
  const source = settings.ruleSource
    ? validateRuleSource(parseJson(String(settings.ruleSource)))
    : undefined;
  const identities = new Set<string>();
  for (const rule of rules) {
    if (
      !record(rule) ||
      !id(rule.id) ||
      ruleIds.has(rule.id) ||
      !text(rule.name, 128) ||
      typeof rule.enabled !== 'boolean' ||
      !text(rule.output, 128) ||
      !record(rule.conditions)
    )
      throw new Error('Invalid or duplicate rule.');
    ruleIds.add(rule.id);
    if (rule.targetMatch !== undefined && !['any', 'all'].includes(jsonText(rule.targetMatch)))
      throw new Error('Invalid destination matching mode.');
    if (rule.applications !== undefined) parseApplicationSelectors(rule.applications);
    if (rule.native !== undefined) parseNativeProjection(rule.native);
    if (typeof rule.matchAll !== 'boolean') throw new Error('Invalid match-all setting.');
    for (const [key, value] of Object.entries(rule.conditions))
      if (!routingConditionFields.some((field) => field.key === key) || !text(value, 16384))
        throw new Error('Invalid rule condition.');
    if (!ids.has(rule.output)) throw new Error('A rule refers to a missing output.');
    if (rule.source !== undefined) {
      if (!source) throw new Error('A sourced rule has no filter source.');
      const row = validateSourceRow(
        rule.source,
        (base) => {
          readRuleTable({
            outputs: JSON.stringify([{ id: base.output, name: 'Source' }]),
            defaultOutput: base.output,
            rules: JSON.stringify([{ ...base, id: 'source-base' }]),
          });
        },
        new Set(routingConditionFields.map((f) => f.key)),
      );
      if (row.identity && identities.has(row.identity))
        throw new Error('Duplicate source rule ID.');
      if (row.identity) identities.add(row.identity);
    }
  }
  return {
    outputs: outputs as NamedOutput[],
    rules: rules as TableRule[],
    defaultOutput: String(settings.defaultOutput),
    ...(source ? { source } : {}),
    ...(tunAmbiguity === undefined
      ? {}
      : { tunAmbiguity: tunAmbiguity as RuleTable['tunAmbiguity'] }),
  };
}
export function tableSettings(table: RuleTable): Record<string, SettingValue> {
  return {
    outputs: JSON.stringify(table.outputs),
    rules: JSON.stringify(table.rules),
    defaultOutput: table.defaultOutput,
    ruleSource: table.source ? JSON.stringify(table.source) : '',
    ...(table.tunAmbiguity ? { tunAmbiguity: JSON.stringify(table.tunAmbiguity) } : {}),
  };
}
export function namedOutputs(data: RuleNodeData): NamedOutput[] {
  try {
    return readRuleTable(data.settings).outputs;
  } catch {
    return [];
  }
}
export function ruleTableProblems(data: RuleNodeData): Diagnostic[] {
  if (!isRuleTableKind(data.kind)) return [];
  const issues: Diagnostic[] = [];
  let location: Partial<Diagnostic> = {};
  const add = (message: string, severity: Diagnostic['severity'] = 'error', fieldKey?: string) =>
    issues.push({ ...location, severity, message, ...(fieldKey ? { fieldKey } : {}) });
  let table: RuleTable;
  try {
    table = readRuleTable(data.settings);
  } catch (error) {
    return [
      {
        severity: 'error',
        message: error instanceof Error ? error.message : 'Invalid rule table.',
      },
    ];
  }
  const names = new Set<string>();
  for (const output of table.outputs) {
    location = { outputId: output.id, fieldKey: 'name' };
    if (!output.name.trim()) add('Give every output a name.');
    if (names.has(output.name.trim().toLowerCase()))
      add(`Output name “${output.name}” is already used.`);
    names.add(output.name.trim().toLowerCase());
  }
  for (const [index, rule] of table.rules.entries()) {
    if (!rule.enabled) continue;
    location = { rowId: rule.id, fieldKey: 'name' };
    const prefix = `Rule ${index + 1}${rule.name ? ` (${rule.name})` : ''}`;
    if (!rule.name.trim()) add(`${prefix}: give the rule a name.`);
    if (rule.matchAll) {
      if (table.rules.slice(index + 1).some((item) => item.enabled))
        add(`${prefix}: match-all hides all later rules.`, 'warning', 'matchAll');
      continue;
    }
    const active = Object.entries(rule.conditions).filter(([key, value]) =>
      routingConditionFields.find((f) => f.key === key)?.list
        ? routingListEntries(value, key).length
        : value.trim(),
    );
    if (!active.length && !rule.applications?.some((r) => r.enabled))
      add(
        `${prefix}: add a condition. Use Unmatched traffic for the default route.`,
        'error',
        'domain',
      );
    for (const [key, value] of active) {
      if (['port', 'sourcePort', 'localPort', 'vlessRoute'].includes(key)) {
        const problem = portRangeProblem(value, key === 'vlessRoute' ? 0 : 1);
        if (problem) add(`${prefix}, ${key}: ${problem}`, 'error', key);
      }
      if (
        ['ip', 'sourceIP', 'localIP'].includes(key) &&
        routingListEntries(value, key).some(ipProblem)
      )
        add(`${prefix}, ${key}: invalid IP, CIDR or GeoIP entry.`, 'error', key);
      if (key === 'domain')
        for (const item of routingListEntries(value, key)) {
          const problem = domainProblem(item);
          if (problem) add(`${prefix}: ${problem}`, 'error', 'domain');
        }
      if (key === 'network' && !['tcp', 'udp', 'tcp,udp'].includes(value))
        add(`${prefix}: choose TCP, UDP or both.`, 'error', 'network');
      if (
        key === 'protocol' &&
        listEntries(value).some((item) => !detectedProtocols.some((p) => p.value === item))
      )
        add(`${prefix}: unknown detected protocol.`, 'error', 'protocol');
      if (key === 'attrs') {
        try {
          const parsed: unknown = parseJson(value);
          if (!record(parsed) || Object.values(parsed).some((item) => typeof item !== 'string'))
            throw new Error();
        } catch {
          add(`${prefix}: HTTP attributes must be a JSON object of strings.`, 'error', 'attrs');
        }
      }
    }
  }
  return issues;
}
export function routingRuleFields(rule: TableRule): Record<string, unknown> {
  if (rule.matchAll) return { network: 'tcp,udp' };
  const fields: Record<string, unknown> = {};
  for (const field of routingConditionFields) {
    const value = rule.conditions[field.key]?.trim();
    if (value && (!field.list || routingListEntries(value, field.key).length))
      fields[field.key] = field.list
        ? routingListEntries(value, field.key)
        : field.key === 'attrs'
          ? parseJson(value)
          : value;
  }
  return fields;
}
// A readable view of this node's rules. Runtime compilation also resolves connected paths.
export function ruleTablePlan(data: RuleNodeData) {
  const table = readRuleTable(data.settings);
  return {
    type: 'wayrill.routing-plan',
    order: 'first-enabled-match',
    outputs: table.outputs,
    rules: table.rules
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        name: rule.name,
        match:
          routingRuleVariants(rule).length === 1
            ? routingRuleVariants(rule)[0]
            : { any: routingRuleVariants(rule) },
        ...(rule.applications?.length ? { applications: rule.applications } : {}),
        output: rule.output,
      })),
    fallback: { output: table.defaultOutput },
    tunAmbiguity:
      table.tunAmbiguity?.action === 'allow'
        ? { action: 'allow', output: table.tunAmbiguity.output || table.defaultOutput }
        : { action: 'block' },
  };
}

/** Internal AND marker survives flattening, then becomes authenticated process metadata. */
export function captureRuleFields(rule: TableRule, captured = false): Record<string, unknown> {
  const fields = routingRuleFields(rule);
  const rows = rule.applications?.filter((r) => r.enabled) ?? [];
  if (!rule.matchAll && rows.length) {
    if (rows.every((r) => r.kind === 'process' && !r.children))
      fields.process = rows.map((r) =>
        r.mode === 'folder' ? r.value.replace(/[\\/]?$/, '/') : r.value,
      );
    else fields._wayrillApplications = [JSON.stringify(rows)];
  }
  if (captured && jsonArray(fields.process)) {
    const rows = nativeProcessSelectors(fields.process.map(String));
    fields._wayrillApplications = [
      ...((fields._wayrillApplications as string[]) ?? []),
      JSON.stringify(rows),
    ];
    delete fields.process;
  }
  return fields;
}

/** Lower the editor's alternatives to core AND predicates, without changing rule precedence. */
export function routingRuleVariants(rule: TableRule): Record<string, unknown>[] {
  return fieldVariants(rule, routingRuleFields(rule));
}

function fieldVariants(
  rule: TableRule,
  fields: Record<string, unknown>,
): Record<string, unknown>[] {
  if (rule.matchAll || rule.targetMatch === 'all') return [fields];
  const keys = ['domain', 'ip', 'process', '_wayrillApplications'];
  const alternatives = keys.filter((key) => Object.hasOwn(fields, key));
  if (!alternatives.length) return [fields];
  const common = Object.fromEntries(Object.entries(fields).filter(([key]) => !keys.includes(key)));
  return alternatives.map((key) => ({ ...common, [key]: fields[key] }));
}

export const hasCaptureOnlyApplications = (rule: TableRule) =>
  !rule.matchAll &&
  !!rule.applications?.some((r) => r.enabled && (r.kind !== 'process' || r.children));

/** Shared filters retain identity predicates until the compiler separates source scopes. */
export function captureRuleVariants(
  rule: TableRule,
  scope: 'native' | 'capture' | 'shared' = 'native',
): Record<string, unknown>[] {
  if (scope === 'capture') return fieldVariants(rule, captureRuleFields(rule, true));
  if (scope === 'native' && hasCaptureOnlyApplications(rule))
    throw new Error(
      `${rule.name}: package, service and child-process matching requires TUN or WinDivert capture connected to this filter.`,
    );
  return fieldVariants(rule, captureRuleFields(rule));
}

export { portRangeProblem } from './portRanges';

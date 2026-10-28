import useEditorSave from './useEditorSave';
import { unavailableRuleIds } from '../graph/resourceAvailability';
import type { ResourceWarningReport } from '../serviceClient';
import {
  sharedFilterSources,
  sharedRuleProblems,
  unsupportedSharedFields,
} from '../graph/internetSharing';
import RoutingLog from './RoutingLog';
import GeoBrowseButton from './GeoBrowseButton';
import { readResources } from '../graph/resources';
import { effectiveDefaults, factoryDefaults } from '../graph/defaults';
import { boundedText } from '../text';
import OutputList from './OutputList';
import RoutingPresetPicker from './RoutingPresetPicker';
import TrafficRuleImport from './TrafficRuleImport';
import TrafficRuleExport from './TrafficRuleExport';
import { deduplicateRule, editSourcedRule } from '../graph/trafficRuleSource';
import { importTrafficPreset, type TrafficPreset } from '../graph/routingPresets';
import ApplicationSelectors from './ApplicationSelectors';
import { nativeProcessSelectors } from '../graph/applications';
import { listEntries } from '../graph/rules';
import { ruleDiagnosticTab } from '../graph/editorNavigation';
import DiagnosticList, {
  useRequestedDiagnostic,
  useLocalDiagnosticFocus,
} from './DiagnosticNavigation';
import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import useModalDialog from './useModalDialog';
import { OrderedEntries, moveEntry } from './OrderedEntries';
import { ruleConditionSummary } from './editorSummaries';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, X, Expand } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  readRuleTable,
  normalizeRuleLists,
  isRuleTableKind,
  routingConditionFields,
  detectedProtocols,
  ruleTablePlan,
  ruleTableProblems,
  tableSettings,
  type NamedOutput,
  type TableRule,
} from '../graph/rules';
import type { GraphState, RuleNode, RuleNodeData } from '../graph/types';

export default function RuleTableEditor({
  node,
  graph,
  resourceWarnings,
  onApply,
  onClose,
  initialTab,
}: {
  initialTab?: 'log' | 'export';
  node: RuleNode;
  resourceWarnings?: Partial<ResourceWarningReport> | null;
  graph: GraphState;
  onApply: (id: string, data: Partial<RuleNodeData>, domainStrategy?: string | null) => void;
  onClose: () => void;
}) {
  const { save, saveError } = useEditorSave(onClose);
  const [expanded, setExpanded] = useState<{ key: string; label: string; value: string } | null>(
    null,
  );
  const expandTrigger = useRef<HTMLButtonElement | null>(null);
  const domainInput = useRef<HTMLTextAreaElement | null>(null);
  const ipInput = useRef<HTMLTextAreaElement | null>(null);
  const expandedInput = useRef<HTMLTextAreaElement | null>(null);
  const resources = useMemo(() => readResources(graph.defaults), [graph.defaults]);
  const requested = useRequestedDiagnostic();
  const dialog = useRef<HTMLDialogElement>(null);
  const [unavailable] = useState(() => unavailableRuleIds(node, graph, resourceWarnings));
  const [table, setTable] = useState(() => {
    const table = readRuleTable(node.data.settings);
    return {
      ...table,
      rules: table.rules.map((rule) =>
        unavailable.has(rule.id) ? { ...rule, enabled: false } : rule,
      ),
    };
  });
  const [selected, setSelected] = useState<string | null>(
    () => requested?.rowId ?? table.rules[0]?.id ?? null,
  );
  const [tab, setTab] = useState<
    'rules' | 'outputs' | 'preview' | 'presets' | 'import' | 'export' | 'log'
  >(initialTab ?? ruleDiagnosticTab(requested));
  const [presetStrategy, setPresetStrategy] = useState<string | null>(null);
  const data = { ...node.data, settings: { ...node.data.settings, ...tableSettings(table) } };
  const missingOutputs: import('../graph/types').Diagnostic[] = [];
  const hasOutput = (id: string) => table.outputs.some((output) => output.id === id);
  if (!table.outputs.length)
    missingOutputs.push({ severity: 'error', fieldKey: 'outputs', message: 'Add an output.' });
  if (!hasOutput(table.defaultOutput))
    missingOutputs.push({
      severity: 'error',
      fieldKey: 'defaultOutput',
      message: 'Choose an output for unmatched traffic.',
    });
  for (const rule of table.rules)
    if (!hasOutput(rule.output))
      missingOutputs.push({
        severity: 'error',
        rowId: rule.id,
        fieldKey: 'output',
        message: `${rule.name || 'Unnamed rule'}: choose an output.`,
      });
  const tunAmbiguity = table.tunAmbiguity ?? { action: 'block', output: '' };
  if (tunAmbiguity.action === 'allow' && tunAmbiguity.output && !hasOutput(tunAmbiguity.output))
    missingOutputs.push({
      severity: 'error',
      fieldKey: 'tunAmbiguity',
      message: 'Choose an output for ambiguous TUN ownership.',
    });
  const sourceScope = sharedFilterSources(graph, node.id);
  const sharedOnly = sourceScope.shared && !sourceScope.host;
  const sharedIssues = sharedRuleProblems(
    { ...graph, nodes: graph.nodes.map((n) => (n.id === node.id ? { ...n, data } : n)) },
    { ...node, data },
  );
  const issues = [
    ...(missingOutputs.length ? missingOutputs : ruleTableProblems(data)),
    ...sharedIssues,
  ];
  const errors = issues.filter((issue) => issue.severity === 'error');
  const selectedRule = table.rules.find((rule) => rule.id === selected);
  const index = table.rules.findIndex((rule) => rule.id === selected);
  const removedEdges = graph.edges.filter(
    (edge) =>
      edge.source === node.id && !table.outputs.some((output) => output.id === edge.sourceHandle),
  );
  const setRule = (update: Partial<TableRule>) =>
    setTable((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === selected
          ? editSourcedRule(rule, {
              ...(update.conditions || update.applications ? { matchAll: false } : {}),
              ...update,
            })
          : rule,
      ),
    }));
  const setOutput = (id: string, update: Partial<NamedOutput>) =>
    setTable((current) => ({
      ...current,
      outputs: current.outputs.map((output) =>
        output.id === id ? { ...output, ...update } : output,
      ),
    }));
  const moveOutput = (id: string, to: number) =>
    setTable((current) => ({
      ...current,
      outputs: moveEntry(
        current.outputs,
        current.outputs.findIndex((o) => o.id === id),
        to,
      ),
    }));
  const focusIssue = useLocalDiagnosticFocus(dialog);
  const reviewLocal = (issue: import('../graph/types').Diagnostic) => {
    setTab(ruleDiagnosticTab(issue));
    if (issue.rowId) setSelected(issue.rowId);
    focusIssue(issue);
  };
  useModalDialog(dialog);
  const tabs = useEditorTabs(
    [
      { key: 'rules', label: `Rules (${table.rules.length})` },
      { key: 'outputs', label: `Outputs (${table.outputs.length})` },
      { key: 'presets', label: 'Presets' },
      { key: 'import', label: 'Import' },
      { key: 'export', label: 'Export' },
      { key: 'preview', label: 'Plan preview' },
      { key: 'log', label: 'Traffic log' },
    ],
    tab,
    setTab,
  );

  function addRule(copy?: TableRule) {
    const rule: TableRule = copy
      ? {
          ...copy,
          id: crypto.randomUUID(),
          name: boundedText(`${copy.name} copy`, 128),
          conditions: { ...copy.conditions },
          applications: copy.applications ? structuredClone(copy.applications) : undefined,
          source: undefined,
        }
      : {
          id: crypto.randomUUID(),
          name: `Rule ${table.rules.length + 1}`,
          enabled: true,
          output: table.defaultOutput,
          conditions: {},
          matchAll: false,
        };
    setTable((current) => ({ ...current, rules: [...current.rules, rule] }));
    setSelected(rule.id);
  }
  function move(id: string, to: number) {
    setTable((current) => ({
      ...current,
      rules: moveEntry(
        current.rules,
        current.rules.findIndex((rule) => rule.id === id),
        to,
      ),
    }));
  }
  const destination = (id: string) => {
    const name = table.outputs.find((output) => output.id === id)?.name || 'Missing output';
    const edge = graph.edges.find((edge) => edge.source === node.id && edge.sourceHandle === id);
    const target = graph.nodes.find((node) => node.id === edge?.target);
    return name === target?.data.label
      ? name
      : `${name} · ${target?.data.label ?? 'Not connected'}`;
  };
  const catchAll = table.rules.findIndex((rule) => rule.enabled && rule.matchAll);
  function addOutput() {
    let count = table.outputs.length + 1;
    while (table.outputs.some((output) => output.name.toLowerCase() === `output ${count}`)) count++;
    setTable((current) => ({
      ...current,
      outputs: [...current.outputs, { id: crypto.randomUUID(), name: `Output ${count}` }],
    }));
  }
  const outputOptions = table.outputs.map((output) => (
    <option key={output.id} value={output.id}>
      {output.name || 'Unnamed output'}
    </option>
  ));
  const conditionField = (key: string, label: string, hint: string, list?: boolean) => {
    if (key === 'protocol') {
      const selectedProtocols = listEntries(selectedRule?.conditions.protocol ?? '');
      const options = [
        ...detectedProtocols,
        ...selectedProtocols
          .filter((value) => !detectedProtocols.some((p) => p.value === value))
          .map((value) => ({ value, label: value })),
      ];
      return (
        <fieldset className="rule-protocols" key={key} data-diagnostic-field={key}>
          <legend>{label}</legend>
          <div className="rule-protocol-options">
            {options.map((p) => (
              <label key={p.value}>
                <input
                  type="checkbox"
                  checked={selectedProtocols.includes(p.value)}
                  onChange={(event) =>
                    setRule({
                      conditions: {
                        ...selectedRule!.conditions,
                        protocol: (event.target.checked
                          ? [...selectedProtocols, p.value]
                          : selectedProtocols.filter((v) => v !== p.value)
                        ).join('\n'),
                      },
                    })
                  }
                />{' '}
                {p.label}
              </label>
            ))}
          </div>
          <small className="field-help">
            {selectedProtocols.length
              ? 'Requires traffic inspection.'
              : 'Any protocol (none selected).'}
          </small>
        </fieldset>
      );
    }
    return (
      <div className="editor-field" key={key} data-diagnostic-field={key}>
        <div className="rule-field-heading">
          <label htmlFor={`rule-condition-${key}`}>{label}</label>
          {['domain', 'ip'].includes(key) && (
            <div className="rule-field-actions">
              <GeoBrowseButton
                kind={key === 'domain' ? 'geosite' : 'geoip'}
                label={label}
                resources={resources}
                target={key === 'domain' ? domainInput : ipInput}
                value={selectedRule?.conditions[key] ?? ''}
                onChange={(value) =>
                  setRule({ conditions: { ...selectedRule!.conditions, [key]: value } })
                }
              />
              <button
                className="icon-button"
                aria-label={`Expand ${label}`}
                title={`Expand ${label}`}
                onClick={(e) => {
                  expandTrigger.current = e.currentTarget;
                  setExpanded({ key, label, value: selectedRule?.conditions[key] ?? '' });
                }}
              >
                <Expand size={14} />
              </button>
            </div>
          )}
        </div>
        {key === 'network' ? (
          <select
            className="text-control"
            id={`rule-condition-${key}`}
            aria-label={label}
            value={selectedRule?.conditions[key] ?? ''}
            onChange={(event) =>
              setRule({ conditions: { ...selectedRule!.conditions, [key]: event.target.value } })
            }
          >
            <option value="">Any network</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="tcp,udp">TCP and UDP</option>
          </select>
        ) : list || key === 'attrs' ? (
          <textarea
            className="text-control"
            ref={key === 'domain' ? domainInput : key === 'ip' ? ipInput : undefined}
            id={`rule-condition-${key}`}
            aria-label={label}
            rows={key === 'domain' || key === 'ip' ? 3 : 2}
            maxLength={16384}
            spellCheck={false}
            value={selectedRule?.conditions[key] ?? ''}
            onChange={(event) =>
              setRule({ conditions: { ...selectedRule!.conditions, [key]: event.target.value } })
            }
          />
        ) : (
          <input
            className="text-control"
            id={`rule-condition-${key}`}
            aria-label={label}
            maxLength={16384}
            value={selectedRule?.conditions[key] ?? ''}
            onChange={(event) =>
              setRule({ conditions: { ...selectedRule!.conditions, [key]: event.target.value } })
            }
          />
        )}
        <small>{hint}</small>
      </div>
    );
  };
  let plan: unknown;
  try {
    plan = ruleTablePlan(data);
  } catch {
    plan = { error: 'Correct invalid conditions to view the plan.' };
  }

  return (
    <dialog
      ref={dialog}
      className="rule-editor-window"
      aria-labelledby="rule-editor-title"
      onCancel={(event) => {
        if (expanded) {
          event.preventDefault();
          setExpanded(null);
          requestAnimationFrame(() => expandTrigger.current?.focus());
        } else onClose();
      }}
      onClose={onClose}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="rule-editor-title">Routing filter · {node.data.label}</h2>
          <p>
            First enabled match wins.
            {graph.edges.some(
              (edge) =>
                edge.source === node.id &&
                graph.nodes.some(
                  (target) => target.id === edge.target && isRuleTableKind(target.data.kind),
                ),
            ) &&
              ' A child filter finishes that path, including its default; evaluation does not return to the parent.'}
          </p>
        </div>
        <button className="icon-button" aria-label="Close editor" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <EditorTabs tabs={tabs} label="Node editor sections" disabled={!!expanded} />
      <EditorTabPanels tabs={tabs} className="rule-editor-body">
        {(tab) => (
          <>
            {tab === 'rules' ? (
              <div className="rule-editor-columns">
                <div className="compact-controls ordered-rules" inert={!!expanded}>
                  <div className="rule-list-tools">
                    <button
                      className="icon-button"
                      aria-label="Add rule"
                      title="Add rule"
                      onClick={() => addRule()}
                      disabled={table.rules.length >= 128}
                    >
                      <Plus size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Move rule up"
                      disabled={!selectedRule || index <= 0}
                      onClick={() => move(selectedRule!.id, index - 1)}
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Move rule down"
                      disabled={!selectedRule || index >= table.rules.length - 1}
                      onClick={() => move(selectedRule!.id, index + 1)}
                    >
                      <ArrowDown size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Duplicate rule"
                      disabled={!selectedRule || table.rules.length >= 128}
                      onClick={() => addRule(selectedRule)}
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Delete rule"
                      title={
                        selectedRule?.source
                          ? 'Delete rule · source rules may return on update; disable a rule to keep it off'
                          : 'Delete rule'
                      }
                      disabled={!selectedRule}
                      onClick={() => {
                        setTable((current) => ({
                          ...current,
                          rules: current.rules.filter((rule) => rule.id !== selected),
                        }));
                        setSelected(
                          table.rules[index + 1]?.id ?? table.rules[index - 1]?.id ?? null,
                        );
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <p className="rule-order-help">↑/↓ select · Alt+↑/↓ reorder</p>
                  <OrderedEntries
                    compact
                    label="Ordered rules"
                    selected={selected}
                    onSelect={setSelected}
                    onMove={move}
                    empty="No rules yet. All traffic follows the default output."
                    entries={table.rules.map((rule, order) => ({
                      ...rule,
                      summary: ruleConditionSummary(rule),
                      destination: destination(rule.output),
                      notice:
                        rule.enabled && catchAll >= 0 && order > catchAll
                          ? `Unreachable after match-all rule ${catchAll + 1}`
                          : issues
                              .filter((issue) => issue.rowId === rule.id)
                              .map((issue) => issue.message)
                              .join(' · '),
                    }))}
                  />
                  <details className="rule-list-footer">
                    <summary>
                      Unmatched traffic{' '}
                      <span>
                        {table.outputs.find((output) => output.id === table.defaultOutput)?.name ||
                          'Choose an output…'}
                      </span>
                    </summary>
                    <label className="editor-field">
                      <span>Default output</span>
                      <select
                        className="text-control"
                        data-diagnostic-field="defaultOutput"
                        value={hasOutput(table.defaultOutput) ? table.defaultOutput : ''}
                        onChange={(event) =>
                          setTable((current) => ({ ...current, defaultOutput: event.target.value }))
                        }
                      >
                        {!hasOutput(table.defaultOutput) && (
                          <option value="">Choose an output…</option>
                        )}
                        {outputOptions}
                      </select>
                    </label>
                    <p className="field-help">{destination(table.defaultOutput)}</p>
                  </details>
                  <details
                    className="rule-list-footer tun-ambiguity-settings"
                    data-diagnostic-field="tunAmbiguity"
                  >
                    <summary>
                      Ambiguous TUN ownership{' '}
                      <span>{tunAmbiguity.action === 'allow' ? 'Allow' : 'Block'}</span>
                    </summary>
                    <label className="editor-field">
                      <span>Action</span>
                      <select
                        className="text-control"
                        aria-label="Ambiguous TUN ownership"
                        value={tunAmbiguity.action}
                        onChange={(e) =>
                          setTable((current) => ({
                            ...current,
                            tunAmbiguity: {
                              ...tunAmbiguity,
                              action: e.target.value as 'block' | 'allow',
                              output: e.target.value === 'block' ? '' : tunAmbiguity.output,
                            },
                          }))
                        }
                      >
                        <option value="block">Block</option>
                        <option value="allow">Allow</option>
                      </select>
                    </label>
                    {tunAmbiguity.action === 'allow' && (
                      <label className="editor-field">
                        <span>Route to</span>
                        <select
                          className="text-control"
                          aria-label="Ambiguous TUN output"
                          value={tunAmbiguity.output}
                          onChange={(e) =>
                            setTable((current) => ({
                              ...current,
                              tunAmbiguity: { ...tunAmbiguity, output: e.target.value },
                            }))
                          }
                        >
                          <option value="">Unmatched traffic</option>
                          {outputOptions}
                        </select>
                      </label>
                    )}
                    <p className="field-help">
                      Skips this filter’s rules. Other ownership failures remain blocked.
                    </p>
                  </details>
                </div>
                <div className="rule-detail">
                  {expanded && (
                    <div className="expanded-rule-field">
                      <div className="rule-field-heading">
                        <h3>{expanded.label}</h3>
                        <GeoBrowseButton
                          kind={expanded.key === 'domain' ? 'geosite' : 'geoip'}
                          label={expanded.label}
                          resources={resources}
                          target={expandedInput}
                          value={expanded.value}
                          onChange={(value) => setExpanded({ ...expanded, value })}
                        />
                      </div>
                      <textarea
                        className="text-control"
                        ref={expandedInput}
                        autoFocus
                        aria-label={`Expanded ${expanded.label}`}
                        spellCheck={false}
                        maxLength={16384}
                        value={expanded.value}
                        onChange={(e) => setExpanded({ ...expanded, value: e.target.value })}
                      />
                      <div>
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setExpanded(null);
                            requestAnimationFrame(() => expandTrigger.current?.focus());
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          className="primary-button"
                          onClick={() => {
                            setRule({
                              conditions: {
                                ...selectedRule!.conditions,
                                [expanded.key]: expanded.value,
                              },
                            });
                            setExpanded(null);
                            requestAnimationFrame(() => expandTrigger.current?.focus());
                          }}
                        >
                          OK
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="rule-detail-normal" hidden={!!expanded}>
                    {selectedRule ? (
                      <>
                        <div className="rule-detail-scroll" data-diagnostic-row={selectedRule?.id}>
                          {table.source && (
                            <p className="field-help">
                              {selectedRule.source?.missing
                                ? 'Kept locally · no longer in source'
                                : selectedRule.source
                                  ? 'Source rule · local additions are kept on update'
                                  : 'Local rule'}
                            </p>
                          )}
                          <div className="editor-two-fields">
                            <label className="editor-field">
                              <span>Rule name</span>
                              <input
                                className="text-control"
                                data-diagnostic-field="name"
                                value={selectedRule.name}
                                onChange={(event) =>
                                  setRule({ name: boundedText(event.target.value, 128) })
                                }
                              />
                            </label>
                            <label className="check-control">
                              <input
                                type="checkbox"
                                checked={selectedRule.enabled}
                                onChange={(event) => setRule({ enabled: event.target.checked })}
                              />{' '}
                              Rule enabled
                            </label>
                          </div>
                          {unavailable.has(selectedRule.id) && (
                            <p className="field-help">
                              Disabled because its geodata matches are unavailable. Entries are
                              preserved.
                            </p>
                          )}
                          <label className="editor-field">
                            <span>Send to output</span>
                            <select
                              className="text-control"
                              data-diagnostic-field="output"
                              value={hasOutput(selectedRule.output) ? selectedRule.output : ''}
                              onChange={(event) => setRule({ output: event.target.value })}
                            >
                              {!hasOutput(selectedRule.output) && (
                                <option value="">Choose an output…</option>
                              )}
                              {outputOptions}
                            </select>
                          </label>
                          <div className="editor-section-heading">
                            Conditions
                            <small>
                              Match destinations below; all additional conditions must also match.
                            </small>
                          </div>
                          {selectedRule.native && (
                            <details className="editor-advanced">
                              <summary>Preserved native rule fields</summary>
                              <p>
                                Unedited fields and their original types are retained. The graph
                                connection controls the destination; displayed conditions control
                                mapped fields.
                              </p>
                              <pre>{JSON.stringify(selectedRule.native.original, null, 2)}</pre>
                            </details>
                          )}
                          <fieldset className="rule-destination-group">
                            <legend>Destination / application</legend>
                            <label className="editor-field">
                              <span>Combine these alternatives</span>
                              <select
                                className="text-control"
                                value={selectedRule.targetMatch ?? 'any'}
                                onChange={(event) =>
                                  setRule({ targetMatch: event.target.value as 'any' | 'all' })
                                }
                              >
                                <option value="any">OR — domain, IP or application</option>
                                <option value="all">
                                  AND — all populated fields (native Xray)
                                </option>
                              </select>
                            </label>
                            {routingConditionFields
                              .slice(0, 2)
                              .map((field) =>
                                conditionField(field.key, field.label, field.hint, field.list),
                              )}
                            {(!sharedOnly ||
                              selectedRule.applications?.length ||
                              selectedRule.conditions.process) && (
                              <ApplicationSelectors
                                rows={
                                  selectedRule.applications ??
                                  nativeProcessSelectors(
                                    listEntries(selectedRule.conditions.process ?? ''),
                                  )
                                }
                                onChange={(applications) =>
                                  setRule({
                                    applications,
                                    conditions: { ...selectedRule.conditions, process: '' },
                                  })
                                }
                              />
                            )}
                            {sourceScope.shared && (
                              <p className="field-message">
                                {sharedOnly
                                  ? 'Shared traffic: destination conditions only. Client identity is unavailable after ICS NAT.'
                                  : 'Application conditions apply to this PC only. ICS uses eligible destination alternatives and fallback.'}
                              </p>
                            )}
                          </fieldset>
                          <div className="editor-section-heading">AND · Additional conditions</div>
                          {routingConditionFields
                            .slice(2, 5)
                            .map((field) =>
                              conditionField(field.key, field.label, field.hint, field.list),
                            )}
                          <details className="editor-advanced">
                            <summary>Source, identity & advanced conditions</summary>
                            {routingConditionFields
                              .slice(5)
                              .filter(
                                (field) =>
                                  field.key !== 'process' &&
                                  (!sharedOnly ||
                                    !unsupportedSharedFields.has(field.key) ||
                                    selectedRule.conditions[field.key]),
                              )
                              .map((field) =>
                                conditionField(field.key, field.label, field.hint, field.list),
                              )}
                          </details>
                        </div>
                      </>
                    ) : (
                      <div className="rule-detail-empty">
                        <h3>One node, many rules.</h3>
                        <p>Add a rule, choose its conditions, then pick a named output.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : tab === 'outputs' ? (
              <div className="output-editor" data-diagnostic-field="outputs">
                <div className="output-editor-heading">
                  <h3>Outputs</h3>
                  <button
                    className="icon-button"
                    aria-label="Add output"
                    title="Add output"
                    onClick={addOutput}
                    disabled={table.outputs.length >= 128}
                  >
                    <Plus size={16} />
                  </button>
                </div>
                <OutputList outputs={table.outputs} label="Routing outputs" onMove={moveOutput}>
                  {(output, order) => {
                    const connected = graph.edges.some(
                      (edge) => edge.source === node.id && edge.sourceHandle === output.id,
                    );
                    return (
                      <>
                        <input
                          className="text-control"
                          aria-label={`Output ${order + 1} name`}
                          data-diagnostic-field="name"
                          value={output.name}
                          onChange={(event) =>
                            setOutput(output.id, { name: boundedText(event.target.value, 64) })
                          }
                        />
                        <span className={connected ? 'output-connected' : undefined}>
                          {connected ? 'Connected' : 'Not connected'}
                        </span>
                        <button
                          className="icon-button"
                          aria-label={`Delete output ${output.name}`}
                          title="Delete output and its connection"
                          onClick={() =>
                            setTable((current) => ({
                              ...current,
                              outputs: current.outputs.filter((o) => o.id !== output.id),
                            }))
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    );
                  }}
                </OutputList>
              </div>
            ) : tab === 'log' ? (
              <RoutingLog
                filterId={node.id}
                outputs={table.outputs}
                rules={table.rules}
                maskAddress={String(
                  effectiveDefaults(graph.defaults ?? factoryDefaults()).maskAddress ?? '',
                )}
              />
            ) : tab === 'import' ? (
              <TrafficRuleImport
                table={table}
                graph={graph}
                node={node}
                onImport={(next, strategy) => {
                  setTable(next);
                  setSelected(next.rules[0]?.id ?? null);
                  if (strategy !== null) setPresetStrategy(strategy);
                  setTab('rules');
                }}
              />
            ) : tab === 'export' ? (
              <TrafficRuleExport table={table} graph={graph} node={node} />
            ) : tab === 'presets' ? (
              <RoutingPresetPicker
                kind="traffic"
                outputs={table.outputs}
                graph={graph}
                node={node}
                onImport={(preset, bindings, mode, strategy) => {
                  const next = importTrafficPreset(table, preset as TrafficPreset, bindings, mode);
                  setTable(next);
                  setSelected(next.rules[0]?.id ?? null);
                  if (mode === 'replace') setPresetStrategy(strategy);
                  setTab('rules');
                }}
              />
            ) : (
              <div className="rule-plan-preview">
                <p>This node’s rules. Run graph compiles all connected paths.</p>
                <pre tabIndex={0}>{JSON.stringify(plan, null, 2)}</pre>
              </div>
            )}
          </>
        )}
      </EditorTabPanels>
      <div className="rule-editor-diagnostics" aria-live="polite">
        {removedEdges.length > 0 && (
          <p className="warning">{removedEdges.length} connection(s) will be removed.</p>
        )}
        <DiagnosticList issues={issues} onIssue={reviewLocal} local />
      </div>
      {saveError && (
        <p className="notice notice--error" role="alert">
          {saveError}
        </p>
      )}
      <div className="rule-editor-footer">
        {errors.length > 0 && <span>{errors.length} issue(s) to correct</span>}
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={errors.length > 0 || !!expanded}
          onClick={() =>
            save(() => {
              onApply(
                node.id,
                {
                  settings: {
                    ...data.settings,
                    ...tableSettings({
                      ...table,
                      rules: table.rules.map((r) => deduplicateRule(normalizeRuleLists(r))),
                    }),
                  },
                },
                presetStrategy,
              );
            })
          }
        >
          Apply changes
        </button>
      </div>
    </dialog>
  );
}

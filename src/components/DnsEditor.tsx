import useEditorSave from './useEditorSave';
import { unavailableRuleIds } from '../graph/resourceAvailability';
import type { ResourceWarningReport } from '../serviceClient';
import AdvancedSettings from './AdvancedSettings';
import GeoMatcherField from './GeoMatcherField';
import { GeoResourcesContext } from '../geodata';
import { readResources } from '../graph/resources';
import { isUdpResolver, tcpResolverAddress, udpDnsPolicyWarnings } from '../graph/dnsTransport';
import { boundedText } from '../text';
import OutputList from './OutputList';
import RoutingPresetPicker from './RoutingPresetPicker';
import { importDnsPreset, type DnsPreset } from '../graph/routingPresets';
import { hasQuestionType, toggleQuestionType } from '../graph/dnsQuestionTypes';
import { exportFile } from '../exportFile';
import { dnsDiagnosticTab } from '../graph/editorNavigation';
import DiagnosticList, {
  useRequestedDiagnostic,
  useLocalDiagnosticFocus,
} from './DiagnosticNavigation';
import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import useModalDialog from './useModalDialog';
import { OrderedEntries, moveEntry } from './OrderedEntries';
import { summarizeTerms } from './editorSummaries';
import { ArrowDown, ArrowUp, Copy, Download, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { coreDefaultHint, formatDefault } from '../graph/coreDefaults';
import { getDefinition } from '../graph/catalog';
import {
  dnsOutputs,
  dnsProblems,
  families,
  familyNames,
  isLocalResolver,
  isNativeDnsHandler,
  newDnsPolicy,
  newDnsRoute,
  newDnsServer,
  readDnsFilter,
  readDnsPolicies,
  readDnsServers,
  type DnsFilter,
  type DnsPolicy,
  type DnsRoute,
  type DnsServer,
} from '../graph/dns';
import { compileDnsGraph } from '../graph/dnsCompilation';
import { FAKE_DNS_PORT } from '../graph/fakeDns';
import type { Diagnostic, GraphState, RuleNode, RuleNodeData, SettingValue } from '../graph/types';

const actions = [
  { value: 'resolve', label: 'Resolve A / AAAA' },
  { value: 'forward', label: 'Forward original query' },
  { value: 'return', label: 'Respond with code' },
  { value: 'drop', label: 'Drop without response' },
];
function TextField({
  label,
  diagnosticKey,
  value,
  onChange,
  help,
  multiline = false,
  hint,
}: {
  label: string;
  diagnosticKey?: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
  multiline?: boolean;
  hint?: string;
}) {
  if (
    multiline &&
    diagnosticKey &&
    ['domain', 'domains', 'expectedIPs', 'unexpectedIPs'].includes(diagnosticKey)
  )
    return (
      <GeoMatcherField
        label={label}
        diagnosticKey={diagnosticKey}
        kind={diagnosticKey.includes('IPs') ? 'geoip' : 'geosite'}
        value={value}
        onChange={onChange}
        hint={hint}
        help={help}
      />
    );
  return (
    <label className="editor-field" data-diagnostic-field={diagnosticKey}>
      <span>{label}</span>
      {multiline ? (
        <textarea
          aria-label={label}
          rows={3}
          placeholder={hint}
          spellCheck={false}
          maxLength={131072}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          autoComplete="off"
          aria-label={label}
          placeholder={hint}
          maxLength={4096}
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help && <small>{help}</small>}
    </label>
  );
}
function NumberField({
  label,
  diagnosticKey,
  value,
  onChange,
  min = 0,
  max = 4294967295,
  help,
}: {
  label: string;
  diagnosticKey?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  help?: string;
}) {
  return (
    <label className="editor-field" data-diagnostic-field={diagnosticKey}>
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        step={1}
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
      {help && <small>{help}</small>}
    </label>
  );
}
function CheckField({
  label,
  diagnosticKey,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  diagnosticKey?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check-control" data-diagnostic-field={diagnosticKey}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
function SelectField({
  label,
  diagnosticKey,
  value,
  options,
  onChange,
  help,
  hint,
  disabled = false,
}: {
  label: string;
  diagnosticKey?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  help?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="editor-field" data-diagnostic-field={diagnosticKey}>
      <span>{label}</span>
      <select
        aria-label={label}
        disabled={disabled}
        className={value === 'inherit' ? 'default-hint-select' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value === 'inherit' && hint ? hint : o.label}
          </option>
        ))}
      </select>
      {help && <small>{help}</small>}
    </label>
  );
}

export default function DnsEditor({
  node,
  graph,
  resourceWarnings,
  onApply,
  onClose,
}: {
  node: RuleNode;
  resourceWarnings?: Partial<ResourceWarningReport> | null;
  graph: GraphState;
  onApply: (id: string, data: Partial<RuleNodeData>) => void;
  onClose: () => void;
}) {
  const { save, saveError } = useEditorSave(onClose);
  const handler = isNativeDnsHandler(node.data),
    group = node.data.kind === 'dns-servers';
  const requested = useRequestedDiagnostic();
  const dialog = useRef<HTMLDialogElement>(null);
  const [unavailable] = useState(() => unavailableRuleIds(node, graph, resourceWarnings));
  const [settings, setSettings] = useState({ ...node.data.settings });
  const [servers, setServers] = useState<DnsServer[]>(() =>
    group ? readDnsServers(settings) : [],
  );
  const [filter, setFilter] = useState<DnsFilter>(() => {
    if (handler || group)
      return { outputs: [], rules: [], fallbackMode: 'always', parallel: false };
    const filter = readDnsFilter(settings);
    return {
      ...filter,
      rules: filter.rules.map((rule) =>
        unavailable.has(rule.id) ? { ...rule, enabled: false } : rule,
      ),
    };
  });
  const [policies, setPolicies] = useState<DnsPolicy[]>(() =>
    handler
      ? readDnsPolicies(settings).map((rule) =>
          unavailable.has(rule.id) ? { ...rule, enabled: false } : rule,
        )
      : [],
  );
  const entries = group ? servers : handler ? policies : filter.rules;
  const [selected, setSelected] = useState<string | null>(
    () => requested?.rowId ?? entries[0]?.id ?? null,
  );
  const [tab, setTab] = useState<'main' | 'settings' | 'preview' | 'presets'>(
    group ? 'main' : dnsDiagnosticTab(requested),
  );
  const configured = {
    ...settings,
    ...(group
      ? { servers: JSON.stringify(servers) }
      : handler
        ? { policyRules: JSON.stringify(policies) }
        : {
            outputs: JSON.stringify(filter.outputs),
            rules: JSON.stringify(filter.rules),
            fallbackMode: filter.fallbackMode,
            parallel: filter.parallel,
            ...(filter.fallbackFirst !== undefined ? { fallbackFirst: filter.fallbackFirst } : {}),
          }),
  };
  const data: RuleNodeData = { ...node.data, settings: configured };
  const namedOutputs = filter.outputs.filter((o) => !o.fallback);
  const fallbackOutput = filter.outputs.find((o) => o.fallback);
  const fallbackEdge = graph.edges.find(
    (edge) => edge.source === node.id && edge.sourceHandle === fallbackOutput?.id,
  );
  const fallbackDestination = graph.nodes.find(
    (candidate) => candidate.id === fallbackEdge?.target,
  );
  const fakeEdge = graph.edges.find(
    (e) => e.source === node.id && e.sourceHandle === FAKE_DNS_PORT,
  );
  const fakeDestination = graph.nodes.find(
    (n) => n.id === fakeEdge?.target && n.data.kind === 'fakedns',
  );
  const managedFakeDns = !!fakeDestination;
  const hasOutput = (id: string) => filter.outputs.some((o) => o.id === id);
  const missingOutputs: Diagnostic[] = filter.rules
    .filter((r) => !hasOutput(r.output))
    .map((r) => ({
      severity: 'error',
      rowId: r.id,
      fieldKey: 'output',
      message: `${r.name || 'Unnamed preference'}: choose an output.`,
    }));
  const issues = missingOutputs.length
      ? missingOutputs
      : dnsProblems(data, { graph, nodeId: node.id }),
    errors = issues.filter((i) => i.severity === 'error');
  const ports = dnsOutputs(data).map((o) => o.id);
  const removed = errors.length
    ? []
    : graph.edges.filter((e) => e.source === node.id && !ports.includes(e.sourceHandle ?? ''));
  const draftGraph = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === node.id ? { ...n, data } : n)),
    edges: graph.edges.filter((e) => !removed.includes(e)),
  };
  let preview = '',
    previewError = '';
  try {
    preview = JSON.stringify(compileDnsGraph(draftGraph), null, 2);
  } catch (error) {
    previewError =
      error instanceof Error
        ? error.message
        : 'Connect the DNS graph to preview its configuration.';
  }
  const index = entries.findIndex((e) => e.id === selected);
  const server = servers.find((e) => e.id === selected),
    policy = policies.find((e) => e.id === selected),
    rule = filter.rules.find((e) => e.id === selected);
  const setting = (key: string, value: SettingValue) =>
    setSettings((s) => ({ ...s, [key]: value }));
  const setServer = (update: Partial<DnsServer>) =>
    setServers((rows) => rows.map((r) => (r.id === selected ? { ...r, ...update } : r)));
  const setPolicy = (update: Partial<DnsPolicy>) =>
    setPolicies((rows) => rows.map((r) => (r.id === selected ? { ...r, ...update } : r)));
  const setRule = (update: Partial<DnsRoute>) =>
    setFilter((f) => ({
      ...f,
      rules: f.rules.map((r) => (r.id === selected ? { ...r, ...update } : r)),
    }));
  const setOutputName = (id: string, name: string) =>
    setFilter((f) => ({
      ...f,
      outputs: f.outputs.map((o) => (o.id === id && !o.fallback ? { ...o, name } : o)),
    }));
  const moveOutput = (id: string, to: number) =>
    setFilter((f) => ({
      ...f,
      outputs: moveEntry(
        f.outputs,
        f.outputs.findIndex((o) => o.id === id),
        to,
      ),
    }));
  const max = group ? 32 : 128;
  const add = (duplicate = false) => {
    const id = crypto.randomUUID();
    if (group)
      setServers((rows) => [
        ...rows,
        duplicate && server ? { ...server, id, name: `${server.name} copy` } : newDnsServer(id),
      ]);
    else if (handler)
      setPolicies((rows) => [
        ...rows,
        duplicate && policy ? { ...policy, id, name: `${policy.name} copy` } : newDnsPolicy(id),
      ]);
    else
      setFilter((f) => ({
        ...f,
        rules: [
          ...f.rules,
          duplicate && rule
            ? { ...rule, id, name: `${rule.name} copy` }
            : newDnsRoute(f.outputs[0].id, id),
        ],
      }));
    setSelected(id);
  };
  const move = (id: string, to: number) => {
    const reorder = <T extends { id: string }>(rows: T[]) =>
      moveEntry(
        rows,
        rows.findIndex((row) => row.id === id),
        to,
      );
    if (group) setServers(reorder);
    else if (handler) setPolicies(reorder);
    else setFilter((f) => ({ ...f, rules: reorder(f.rules) }));
  };
  const remove = () => {
    if (group) setServers((rows) => rows.filter((r) => r.id !== selected));
    else if (handler) setPolicies((rows) => rows.filter((r) => r.id !== selected));
    else setFilter((f) => ({ ...f, rules: f.rules.filter((r) => r.id !== selected) }));
    setSelected(entries[index + 1]?.id ?? entries[index - 1]?.id ?? null);
  };
  const [exportError, setExportError] = useState('');
  const exportFragment = async () => {
    try {
      await exportFile('wayrill-dns.xray-fragment.json', preview);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  };
  const focusIssue = useLocalDiagnosticFocus(dialog);
  const reviewLocal = (issue: import('../graph/types').Diagnostic) => {
    setTab(group ? 'main' : dnsDiagnosticTab(issue));
    if (issue.rowId) setSelected(issue.rowId);
    focusIssue(issue);
  };
  useModalDialog(dialog);
  const resources = useMemo(() => readResources(graph.defaults), [graph.defaults]);
  const tabs = useEditorTabs(
    [
      {
        key: 'main',
        label: group
          ? `Servers (${servers.length})`
          : handler
            ? `Query policies (${policies.length})`
            : `Preferences (${filter.rules.length})`,
      },
      ...(!group
        ? [
            {
              key: 'settings' as const,
              label: handler ? 'Resolver settings' : 'Outputs',
            },
          ]
        : []),
      ...(!handler && !group ? [{ key: 'presets' as const, label: 'Presets' }] : []),
      { key: 'preview', label: 'Xray DNS preview' },
    ],
    tab,
    setTab,
  );
  const resolverDefaults =
    graph.nodes.find((n) => n.data.kind === 'dns-handler')?.data.settings ?? {};
  const resolverHint = (key: string) => {
    const actual = resolverDefaults[key];
    return actual === undefined || actual === ''
      ? coreDefaultHint('DNSConfig.' + (key === 'clientIP' ? 'clientIp' : key)).text
      : formatDefault(actual);
  };
  const title = getDefinition(node.data.kind).title;
  const familyOptions = (inherit: boolean) =>
    families
      .filter((f) => inherit || f !== 'inherit')
      .map((value) => ({ value, label: familyNames[value] }));
  const preferenceHelp =
    'One entry per line: domain:example.net, full:host.example, keyword:…, regexp:…, geosite:…';

  return (
    <GeoResourcesContext.Provider value={resources}>
      <dialog
        ref={dialog}
        className="rule-editor-window dns-editor-window"
        aria-labelledby="dns-editor-title"
        onCancel={onClose}
        onClose={onClose}
      >
        <div className="rule-editor-titlebar">
          <div>
            <h2 id="dns-editor-title">
              {title} · {node.data.label}
            </h2>
            <p>
              {group
                ? 'Query traffic follows this group’s outgoing path.'
                : handler
                  ? 'Control DNS request handling and the shared Xray resolver.'
                  : 'Matching groups are tried in order, then eligible fallback servers. Answer IP checks follow resolution.'}
            </p>
          </div>
          <button className="icon-button" aria-label="Close editor" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <EditorTabs tabs={tabs} label="DNS editor sections" />
        <EditorTabPanels tabs={tabs} className="rule-editor-body">
          {(tab) => (
            <>
              {tab === 'main' ? (
                <div className="rule-editor-columns">
                  <div className="compact-controls ordered-rules">
                    <div className="rule-list-tools">
                      <button
                        className="icon-button"
                        aria-label={`Add ${group ? 'server' : handler ? 'policy' : 'preference'}`}
                        title={`Add ${group ? 'server' : handler ? 'policy' : 'preference'}`}
                        onClick={() => add()}
                        disabled={entries.length >= max}
                      >
                        <Plus size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Move entry up"
                        disabled={index <= 0}
                        onClick={() => move(selected!, index - 1)}
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Move entry down"
                        disabled={index < 0 || index === entries.length - 1}
                        onClick={() => move(selected!, index + 1)}
                      >
                        <ArrowDown size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Duplicate entry"
                        disabled={index < 0 || entries.length >= max}
                        onClick={() => add(true)}
                      >
                        <Copy size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Delete entry"
                        disabled={index < 0 || (group && entries.length === 1)}
                        onClick={remove}
                      >
                        <Trash2 size={16} />
                      </button>
                      <span>{entries.filter((r) => r.enabled).length} active</span>
                    </div>
                    <p className="rule-order-help">
                      {(group || handler) && (
                        <>
                          {group
                            ? 'Equivalent adjacent servers may run in parallel when enabled in DNS routing.'
                            : 'Top to bottom · first enabled request policy wins.'}
                          <br />
                        </>
                      )}
                      ↑/↓ select · Alt+↑/↓ reorder
                    </p>
                    {selected && unavailable.has(selected) && (
                      <p className="field-help">
                        Disabled because its geodata matches are unavailable. Entries are preserved.
                      </p>
                    )}
                    <OrderedEntries
                      compact
                      label={
                        group
                          ? 'Ordered DNS servers'
                          : handler
                            ? 'Ordered DNS policies'
                            : 'Ordered DNS preferences'
                      }
                      selected={selected}
                      onSelect={setSelected}
                      onMove={move}
                      empty={
                        handler
                          ? 'Only the default query policy applies.'
                          : 'No preferences. Use Fallback for unmatched names.'
                      }
                      entries={entries.map((entry) => ({
                        ...entry,
                        summary: group
                          ? (entry as DnsServer).address
                          : handler
                            ? `Domains: ${summarizeTerms((entry as DnsPolicy).domain) || 'Any'} AND record types: ${(entry as DnsPolicy).qType || 'Any'}`
                            : `Domains: ${summarizeTerms((entry as DnsRoute).domains) || 'Any'}`,
                        destination: group
                          ? undefined
                          : handler
                            ? actions.find((a) => a.value === (entry as DnsPolicy).action)?.label
                            : filter.outputs.find((o) => o.id === (entry as DnsRoute).output)?.name,
                      }))}
                    />
                    {!handler && !group && (
                      <details className="rule-list-footer" aria-label="DNS fallback">
                        <summary>
                          Fallback{' '}
                          <span>
                            {managedFakeDns
                              ? 'Required by FakeDNS'
                              : filter.fallbackMode === 'disabled'
                                ? 'Disabled'
                                : filter.fallbackMode === 'when-unmatched'
                                  ? 'Unmatched only'
                                  : 'After preferences'}
                          </span>
                        </summary>
                        <SelectField
                          label="Fallback policy"
                          diagnosticKey="fallbackMode"
                          value={managedFakeDns ? 'always' : filter.fallbackMode}
                          disabled={managedFakeDns}
                          options={[
                            { value: 'always', label: 'After matching preferences fail' },
                            { value: 'when-unmatched', label: 'Only when no preference matches' },
                            { value: 'disabled', label: 'Disabled' },
                          ]}
                          onChange={(fallbackMode) => setFilter((f) => ({ ...f, fallbackMode }))}
                        />
                        <p className="field-help" aria-label="Fallback output">
                          Fallback → {fallbackDestination?.data.label ?? 'Not connected'}
                          {managedFakeDns && ' · Real IP lookups'}
                        </p>
                        <AdvancedSettings
                          title="Resolver order"
                          configured={[
                            ...(!managedFakeDns && filter.fallbackFirst ? ['Fallback first'] : []),
                            ...(!managedFakeDns && filter.parallel ? ['Parallel queries'] : []),
                          ]}
                        >
                          {!managedFakeDns && (
                            <CheckField
                              label="Fallback servers first in core config"
                              diagnosticKey="fallbackFirst"
                              checked={filter.fallbackFirst ?? false}
                              onChange={(fallbackFirst) =>
                                setFilter((f) => ({ ...f, fallbackFirst }))
                              }
                            />
                          )}
                          <CheckField
                            label={
                              managedFakeDns
                                ? 'Parallel DNS queries · Off with FakeDNS'
                                : 'Query equivalent adjacent servers in parallel'
                            }
                            diagnosticKey="parallel"
                            checked={!managedFakeDns && filter.parallel}
                            disabled={managedFakeDns}
                            onChange={(parallel) => setFilter((f) => ({ ...f, parallel }))}
                          />
                        </AdvancedSettings>
                      </details>
                    )}
                    {handler && (
                      <div className="rule-list-footer">
                        <strong>Unmatched DNS requests</strong>
                        <SelectField
                          label="Default query action"
                          diagnosticKey="policyDefault"
                          value={String(settings.policyDefault)}
                          options={actions.filter((a) => a.value !== 'resolve')}
                          onChange={(v) => setting('policyDefault', v)}
                        />
                        {settings.policyDefault === 'return' && (
                          <NumberField
                            label="Default response code"
                            diagnosticKey="policyRCode"
                            value={Number(settings.policyRCode)}
                            max={65535}
                            onChange={(v) => setting('policyRCode', v)}
                            help="0 NOERROR · 3 NXDOMAIN · 5 REFUSED"
                          />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="rule-detail">
                    {index >= 0 ? (
                      <>
                        <div className="rule-detail-tools">
                          <span>
                            {group ? 'SERVER' : handler ? 'POLICY' : 'PREFERENCE'} {index + 1} OF{' '}
                            {entries.length}
                          </span>
                        </div>
                        <div
                          className="rule-detail-scroll"
                          data-diagnostic-row={selected ?? undefined}
                        >
                          {server && group && (
                            <>
                              <div className="editor-two-fields">
                                <TextField
                                  label="Server name"
                                  diagnosticKey="name"
                                  value={server.name}
                                  onChange={(name) => setServer({ name })}
                                />
                                <CheckField
                                  label="Server enabled"
                                  diagnosticKey="enabled"
                                  checked={server.enabled}
                                  onChange={(enabled) => setServer({ enabled })}
                                />
                              </div>
                              <TextField
                                label="Resolver address"
                                diagnosticKey="address"
                                value={server.address}
                                onChange={(address) => setServer({ address })}
                                help="UDP: IP literal · TCP: tcp://IP:port · DoH: https://host/dns-query. +local modes and localhost bypass routing."
                              />
                              {isUdpResolver(server.address) && (
                                <div className="dns-transport-action">
                                  {udpDnsPolicyWarnings(graph).some(
                                    (i) => i.nodeId === node.id && i.rowId === server.id,
                                  ) && (
                                    <p className="editor-note">
                                      UDP DNS can keep a failed policy route. TCP DNS follows the
                                      current candidate on each request.
                                    </p>
                                  )}
                                  <button
                                    className="secondary-button"
                                    disabled={errors.length > 0}
                                    onClick={() =>
                                      setServer({
                                        address: tcpResolverAddress(server.address, server.port),
                                      })
                                    }
                                  >
                                    Use TCP DNS
                                  </button>
                                </div>
                              )}
                              {!server.address.includes('://') &&
                                server.address !== 'localhost' && (
                                  <NumberField
                                    label="UDP port"
                                    diagnosticKey="port"
                                    value={server.port}
                                    min={1}
                                    max={65535}
                                    onChange={(port) => setServer({ port })}
                                  />
                                )}
                              <div className="dns-field-grid">
                                <SelectField
                                  hint={resolverHint('queryStrategy')}
                                  label="Server address family"
                                  diagnosticKey="queryStrategy"
                                  value={server.queryStrategy}
                                  options={familyOptions(true)}
                                  onChange={(queryStrategy) => setServer({ queryStrategy })}
                                  help="Further restricted by the handler’s address-family policy."
                                />
                              </div>
                              <AdvancedSettings
                                title="Resolver tuning"
                                configured={[
                                  ...(server.timeoutMs !== 4000 ? ['Query timeout'] : []),
                                  ...(server.clientIP ? ['EDNS client IP'] : []),
                                  ...(server.cache !== 'inherit' ? ['Cache override'] : []),
                                  ...(server.stale !== 'inherit' ? ['Stale answers'] : []),
                                  ...(server.staleTTL !== 0 ? ['Stale TTL'] : []),
                                ]}
                              >
                                <NumberField
                                  label="Timeout (ms)"
                                  diagnosticKey="timeoutMs"
                                  value={server.timeoutMs}
                                  min={1}
                                  max={600000}
                                  onChange={(timeoutMs) => setServer({ timeoutMs })}
                                />
                                <TextField
                                  hint={resolverHint('clientIP')}
                                  label="Server EDNS client IP"
                                  diagnosticKey="clientIP"
                                  value={server.clientIP}
                                  onChange={(clientIP) => setServer({ clientIP })}
                                  help="Optional IP literal. Empty inherits the handler setting."
                                />
                                <h4>Cache overrides</h4>
                                <div className="dns-field-grid">
                                  <SelectField
                                    hint={
                                      resolverDefaults.disableCache
                                        ? 'Cache disabled'
                                        : 'Cache enabled'
                                    }
                                    label="Server cache"
                                    diagnosticKey="disableCache"
                                    value={server.cache}
                                    options={[
                                      { value: 'inherit', label: 'Use handler setting' },
                                      { value: 'enabled', label: 'Cache answers' },
                                      { value: 'disabled', label: 'Disable cache' },
                                    ]}
                                    onChange={(cache) => setServer({ cache })}
                                  />
                                  <SelectField
                                    hint={
                                      resolverDefaults.serveStale
                                        ? 'Serve stale answers'
                                        : 'Do not serve stale answers'
                                    }
                                    label="Server stale answers"
                                    diagnosticKey="serveExpired"
                                    value={server.stale}
                                    options={[
                                      { value: 'inherit', label: 'Use handler setting' },
                                      { value: 'enabled', label: 'Serve stale answers' },
                                      { value: 'disabled', label: 'Do not serve stale answers' },
                                    ]}
                                    onChange={(stale) => setServer({ stale })}
                                  />
                                </div>
                                <NumberField
                                  label="Server stale TTL (seconds)"
                                  diagnosticKey="serveExpiredTTL"
                                  value={server.staleTTL}
                                  onChange={(staleTTL) => setServer({ staleTTL })}
                                  help="0 inherits the global TTL; nonzero emits serveExpiredTTL."
                                />
                              </AdvancedSettings>
                              {isLocalResolver(server.address) && (
                                <p className="editor-note">
                                  This server uses local mode. Xray’s resolver transport bypasses
                                  the group’s Query traffic connection.
                                </p>
                              )}
                            </>
                          )}
                          {policy && handler && (
                            <>
                              <div className="editor-two-fields">
                                <TextField
                                  label="Policy name"
                                  diagnosticKey="name"
                                  value={policy.name}
                                  onChange={(name) => setPolicy({ name })}
                                />
                                <CheckField
                                  label="Policy enabled"
                                  diagnosticKey="enabled"
                                  checked={policy.enabled}
                                  onChange={(enabled) => setPolicy({ enabled })}
                                />
                              </div>
                              <SelectField
                                label="Query action"
                                diagnosticKey="action"
                                value={policy.action}
                                options={actions}
                                onChange={(action) =>
                                  setPolicy({ action: action as DnsPolicy['action'] })
                                }
                              />
                              {policy.action === 'return' && (
                                <NumberField
                                  label="Response code"
                                  diagnosticKey="rcode"
                                  value={policy.rCode}
                                  max={65535}
                                  onChange={(rCode) => setPolicy({ rCode })}
                                  help="0 NOERROR · 3 NXDOMAIN · 5 REFUSED"
                                />
                              )}
                              <TextField
                                hint={'All domains'}
                                label="Queried domains"
                                diagnosticKey="domain"
                                value={policy.domain}
                                onChange={(domain) => setPolicy({ domain })}
                                multiline
                                help={`${preferenceHelp}. Empty matches any domain.`}
                              />
                              <fieldset className="dns-record-types" data-diagnostic-field="qType">
                                <legend>DNS record types</legend>
                                <div className="compact-controls dns-record-type-options">
                                  {[
                                    [1, 'A'],
                                    [28, 'AAAA'],
                                    [64, 'SVCB'],
                                    [65, 'HTTPS'],
                                    [15, 'MX'],
                                    [16, 'TXT'],
                                    [12, 'PTR'],
                                  ].map(([value, name]) => (
                                    <label
                                      key={value}
                                      className="check-control check-control--compact"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={hasQuestionType(policy.qType, Number(value))}
                                        onChange={(e) =>
                                          setPolicy({
                                            qType: toggleQuestionType(
                                              policy.qType,
                                              Number(value),
                                              e.target.checked,
                                            ),
                                          })
                                        }
                                      />
                                      {name}
                                    </label>
                                  ))}
                                </div>
                                <TextField
                                  hint="All types"
                                  label="Type codes / ranges"
                                  diagnosticKey="qType"
                                  value={policy.qType}
                                  onChange={(qType) => setPolicy({ qType })}
                                />
                              </fieldset>
                              <p className="editor-note">
                                Policies use the first enabled match. Domain and record-type
                                conditions must both match. Resolve uses the connected DNS
                                filter/server group for A/AAAA. Forward uses one plaintext endpoint
                                and the Forward queries path.
                              </p>
                            </>
                          )}
                          {rule && !handler && !group && (
                            <>
                              <div className="editor-two-fields">
                                <TextField
                                  label="Preference name"
                                  diagnosticKey="name"
                                  value={rule.name}
                                  onChange={(name) => setRule({ name })}
                                />
                                <CheckField
                                  label="Preference enabled"
                                  diagnosticKey="enabled"
                                  checked={rule.enabled}
                                  onChange={(enabled) => setRule({ enabled })}
                                />
                              </div>
                              <SelectField
                                label="Preferred output"
                                diagnosticKey="output"
                                value={hasOutput(rule.output) ? rule.output : ''}
                                options={[
                                  ...(!hasOutput(rule.output)
                                    ? [{ value: '', label: 'Choose an output…' }]
                                    : []),
                                  ...filter.outputs.map((o) => ({ value: o.id, label: o.name })),
                                ]}
                                onChange={(output) => setRule({ output })}
                              />
                              <TextField
                                hint={'All domains'}
                                label="Preferred domains"
                                diagnosticKey="domains"
                                value={rule.domains}
                                onChange={(domains) => setRule({ domains })}
                                multiline
                                help={preferenceHelp}
                              />
                              <div className="dns-field-grid">
                                <TextField
                                  hint={'Any answer IP'}
                                  label="Expected answer IPs"
                                  diagnosticKey="expectedIPs"
                                  value={rule.expectedIPs}
                                  onChange={(expectedIPs) => setRule({ expectedIPs })}
                                  multiline
                                  help="IP, CIDR, geoip:… or !CIDR, one per line. Empty accepts any answer; * preserves original answers."
                                />
                                <TextField
                                  hint={'No rejected IPs'}
                                  label="Rejected answer IPs"
                                  diagnosticKey="unexpectedIPs"
                                  value={rule.unexpectedIPs}
                                  onChange={(unexpectedIPs) => setRule({ unexpectedIPs })}
                                  multiline
                                  help="Maps to unexpectedIPs. IP/CIDR/GeoIP lists; * uses Xray’s keep-original behavior."
                                />
                              </div>
                              <CheckField
                                label="Skip these preferred servers during fallback"
                                checked={rule.skipFallback}
                                onChange={(skipFallback) => setRule({ skipFallback })}
                              />
                              <CheckField
                                label="Stop trying other groups after this group"
                                checked={rule.finalQuery}
                                onChange={(finalQuery) => setRule({ finalQuery })}
                              />
                              <p className="editor-note">
                                Each active server in the chosen group gets these domain and answer
                                checks. Stop applies to the last active server, so the whole group
                                can be tried.
                              </p>
                            </>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="rule-detail-empty">
                        <h3>{handler ? 'Control DNS requests.' : 'Choose servers by domain.'}</h3>
                        <p>Add {handler ? 'a query policy' : 'a preference'} to get started.</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : tab === 'settings' && handler ? (
                <div className="output-editor">
                  <div className="dns-field-grid">
                    <SelectField
                      label="Handler address family"
                      diagnosticKey="queryStrategy"
                      value={String(settings.queryStrategy)}
                      options={familyOptions(false)}
                      onChange={(v) => setting('queryStrategy', v)}
                    />
                  </div>
                  <TextField
                    hint={coreDefaultHint('DNSConfig.hosts').text}
                    label="Static hosts / bootstrap (JSON)"
                    diagnosticKey="hosts"
                    value={String(settings.hosts)}
                    onChange={(v) => setting('hosts', v)}
                    multiline
                    help={
                      'Maps to dns.hosts. Example: {"full:dns.example.net":["1.1.1.1"]}. Hostname bootstrap must avoid resolver re-entry loops.'
                    }
                  />
                  <CheckField
                    label="Use system hosts file"
                    diagnosticKey="useSystemHosts"
                    checked={!!settings.useSystemHosts}
                    onChange={(v) => setting('useSystemHosts', v)}
                  />
                  <AdvancedSettings
                    title="Resolver tuning"
                    configured={[
                      ...(settings.clientIP ? ['EDNS client IP'] : []),
                      ...(settings.disableCache ? ['Cache disabled'] : []),
                      ...(settings.serveStale ? ['Stale answers'] : []),
                      ...(settings.serveExpiredTTL ? ['Stale TTL'] : []),
                    ]}
                  >
                    <TextField
                      hint={coreDefaultHint('DNSConfig.clientIp').text}
                      label="Handler EDNS client IP"
                      diagnosticKey="clientIP"
                      value={String(settings.clientIP)}
                      onChange={(v) => setting('clientIP', v)}
                      help="Optional clientIp shared by resolvers."
                    />{' '}
                    <CheckField
                      label="Disable resolver cache"
                      diagnosticKey="disableCache"
                      checked={!!settings.disableCache}
                      onChange={(v) => setting('disableCache', v)}
                    />
                    <CheckField
                      label="Serve stale cached answers"
                      diagnosticKey="serveExpired"
                      checked={!!settings.serveStale}
                      onChange={(v) => setting('serveStale', v)}
                    />
                    <NumberField
                      label="Stale answer TTL (seconds)"
                      diagnosticKey="serveExpiredTTL"
                      value={Number(settings.serveExpiredTTL)}
                      onChange={(v) => setting('serveExpiredTTL', v)}
                    />
                  </AdvancedSettings>
                  {policies.some((p) => p.enabled && p.action === 'forward') ||
                  settings.policyDefault === 'forward' ? (
                    <>
                      <div className="editor-section-heading">
                        Forward original DNS requests
                        <small>
                          Separate from the global A/AAAA resolver. The endpoint cannot be selected
                          by domain rules.
                        </small>
                      </div>
                      <div className="dns-field-grid">
                        <SelectField
                          label="Forward network"
                          diagnosticKey="rewriteNetwork"
                          value={String(settings.rewriteNetwork)}
                          options={[
                            { value: 'udp', label: 'UDP' },
                            { value: 'tcp', label: 'TCP' },
                          ]}
                          onChange={(v) => setting('rewriteNetwork', v)}
                        />
                        <NumberField
                          label="Forward port"
                          diagnosticKey="rewritePort"
                          value={Number(settings.rewritePort)}
                          min={1}
                          max={65535}
                          onChange={(v) => setting('rewritePort', v)}
                        />
                      </div>
                      <TextField
                        label="Forward address"
                        diagnosticKey="rewriteAddress"
                        value={String(settings.rewriteAddress)}
                        onChange={(v) => setting('rewriteAddress', v)}
                        help="Explicit IP literal. Connect Forward queries to Direct, VLESS or Block."
                      />
                    </>
                  ) : null}
                  <p className="editor-note">
                    Xray has one shared DNS module per config. Choosing IPv4 only limits built-in
                    resolution; use a query policy to return or drop AAAA requests explicitly.
                  </p>
                </div>
              ) : tab === 'settings' ? (
                <div className="output-editor">
                  <div className="section-heading">
                    <h3>Outputs</h3>
                    <button
                      className="icon-button"
                      aria-label="Add output"
                      title="Add output"
                      disabled={filter.outputs.length >= 16}
                      onClick={() =>
                        setFilter((f) => ({
                          ...f,
                          outputs: [
                            ...f.outputs,
                            {
                              id: crypto.randomUUID(),
                              name: `Servers ${namedOutputs.length + 1}`,
                              fallback: false,
                            },
                          ],
                        }))
                      }
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  <OutputList
                    outputs={filter.outputs}
                    label="DNS routing outputs"
                    onMove={moveOutput}
                    rowClass={(output) => (output.fallback ? 'dns-fallback-output' : '')}
                  >
                    {(output, order) => {
                      const connected = graph.edges.some(
                        (e) => e.source === node.id && e.sourceHandle === output.id,
                      );
                      return (
                        <>
                          {output.fallback ? (
                            <strong>Fallback</strong>
                          ) : (
                            <input
                              aria-label={`Output ${order + 1} name`}
                              data-diagnostic-field="name"
                              spellCheck={false}
                              value={output.name}
                              onChange={(e) =>
                                setOutputName(output.id, boundedText(e.target.value, 128))
                              }
                            />
                          )}
                          <span className={connected ? 'output-connected' : undefined}>
                            {connected ? 'Connected' : 'Unconnected'}
                          </span>
                          {!output.fallback && (
                            <button
                              className="icon-button"
                              aria-label={`Delete output ${output.name}`}
                              title="Apply removes this output and its connection."
                              onClick={() =>
                                setFilter((f) => ({
                                  ...f,
                                  outputs: f.outputs.filter((o) => o.id !== output.id),
                                }))
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </>
                      );
                    }}
                  </OutputList>
                  <div className="output-editor-row dns-fakedns-output" aria-label="FakeDNS output">
                    <strong>FakeDNS</strong>
                    <span className={managedFakeDns ? 'output-connected' : undefined}>
                      {fakeDestination?.data.label ?? 'Optional · connect a FakeDNS node'}
                    </span>
                  </div>
                  {managedFakeDns && (
                    <p className="field-help">
                      Synthetic answers follow the preferences. Name recovery is automatic; Fallback
                      supplies real IP lookups.
                    </p>
                  )}
                </div>
              ) : tab === 'presets' ? (
                <RoutingPresetPicker
                  kind="dns"
                  outputs={filter.outputs}
                  graph={graph}
                  node={node}
                  onImport={(preset, bindings, mode) => {
                    const next = importDnsPreset(filter, preset as DnsPreset, bindings, mode);
                    setFilter(next);
                    setSelected(next.rules[0]?.id ?? null);
                    setTab('main');
                  }}
                />
              ) : (
                <div className="rule-plan-preview">
                  <div className="dns-preview-heading">
                    <p>
                      DNS fragment including draft changes. Listener and traffic routing are
                      separate.
                    </p>
                    <button
                      className="secondary-button"
                      disabled={!preview || errors.length > 0}
                      onClick={() => void exportFragment()}
                    >
                      <Download size={15} />
                      Export DNS fragment
                    </button>
                  </div>
                  {previewError ? (
                    <p className="field-message error">{previewError}</p>
                  ) : (
                    <pre className="code-block" tabIndex={0}>
                      {preview}
                    </pre>
                  )}
                </div>
              )}
            </>
          )}
        </EditorTabPanels>
        <div className="rule-editor-diagnostics" aria-live="polite">
          {removed.length > 0 && (
            <p className="warning">
              Apply removes {removed.length} connection(s) belonging to removed outputs. Undo
              restores them.
            </p>
          )}
          {exportError && <p role="alert">{exportError}</p>}
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
            disabled={errors.length > 0}
            onClick={() => save(() => onApply(node.id, { settings: configured }))}
          >
            Apply changes
          </button>
        </div>
      </dialog>
    </GeoResourcesContext.Provider>
  );
}

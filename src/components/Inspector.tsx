import { nodeSettingGroups } from '../graph/settingsLayout';
import { automaticFakeDns } from '../graph/fakeDns';
import AdvancedSettings from './AdvancedSettings';
import InboundSocketBuffers from './InboundSocketBuffers';
import { jsonArray, jsonRecord } from '../graph/xrayJson';
import { boundedText } from '../text';
import {
  ArrowDownRight,
  ArrowUpRight,
  Cable,
  ChevronRight,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { DiagnosticFocusContext, focusDiagnostic } from './DiagnosticNavigation';
import { useContext, useEffect, useRef, useMemo, useState } from 'react';
import InheritableSetting from './InheritableSetting';
import {
  settingDefaultState,
  bindingFor,
  bindingsFor,
  overrideSetting,
  resetNodeDefaults,
  resolveNodeData,
} from '../graph/defaults';
import { getDefinition, getOutputPorts, portLabel } from '../graph/catalog';
import { connectionTypes, sourceConnectionKind } from '../graph/connectionTypes';
import { connectionDescription, connectionIsEditable } from '../graph/connectionEditing';
import { isExecutableOutboundKind, outboundBundle } from '../graph/outbounds';
import { isFieldVisible } from '../graph/settingValidation';
import { inboundPreview, isInboundKind } from '../graph/inbounds';
import { isNativeConfigEditor } from '../graph/xrayNodes';
import {
  captureNodeName,
  isProtocolKind,
  isProtocolInbound,
  nativeValue,
  setNative,
} from '../graph/protocols';
import { isTunKind } from '../graph/tun';
import { xrayInboundConfig, xrayOutboundConfig } from '../graph/xrayCompiler';
import { isPolicyKind } from '../graph/policies';
import { isRuleTableKind } from '../graph/rules';
import { isDnsEditor, isNativeDnsHandler } from '../graph/dns';
import type {
  Diagnostic,
  GraphState,
  RuleEdge,
  RuleNode,
  RuleNodeData,
  SettingDefinition,
  SettingValue,
} from '../graph/types';
import NodeIcon from './NodeIcon';
import { isGraphInbound, isDisabledInbound } from '../graph/inboundState';

interface Props {
  libraryEdit?: boolean;
  graph: GraphState;
  diagnostics: Diagnostic[];
  node?: RuleNode;
  edge?: RuleEdge;
  selectedCount: number;
  onUpdate: (id: string, update: Partial<RuleNodeData>) => void;
  onSelect: (id: string) => void;
  onConnect: (sourceId: string, port?: string) => void;
  onSelectConnection: (id: string) => void;
  onEditConnection: (id: string) => void;
  onShowConnection: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: () => void;
  onClose: () => void;
  onBeginFieldEdit?: () => void;
  onEndFieldEdit?: () => void;
}
function editorAction(data: RuleNodeData): string | null {
  if (data.kind === 'ics-tun') return 'Edit Internet sharing…';
  if (isProtocolKind(data.kind) || ['xray-inbound', 'xray-outbound'].includes(data.kind))
    return 'Edit protocol settings…';
  if (isNativeConfigEditor(data.kind))
    return data.kind === 'xray-options'
      ? 'Edit core settings…'
      : data.kind === 'xray-dns'
        ? 'Edit DNS handler…'
        : 'Edit DNS servers…';
  if (data.kind === 'windivert-inbound') return 'Edit adapters…';
  if (data.kind === 'proxy-chain') return 'Edit proxy chain…';
  if (isPolicyKind(data.kind))
    return data.kind === 'policy-group' ? 'Edit policy group…' : 'Edit observatory…';
  if (data.kind === 'fakedns') return 'Edit FakeDNS…';
  if (isDnsEditor(data))
    return data.kind === 'dns-servers'
      ? 'Edit DNS servers…'
      : isNativeDnsHandler(data)
        ? 'Edit DNS handler…'
        : 'Edit DNS routing…';
  return isRuleTableKind(data.kind) ? 'Edit routing rules…' : null;
}

function NodeDescription({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(Boolean(value));
  return (
    <details
      className="settings-section"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={13} />
        <span>Description</span>
        <small>optional</small>
      </summary>
      <div className="settings-section-body field">
        <textarea
          id="node-description"
          aria-label="Description"
          rows={2}
          maxLength={4096}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </details>
  );
}

export default function Inspector({
  libraryEdit = false,
  graph,
  diagnostics,
  node,
  edge,
  selectedCount,
  onUpdate,
  onSelect,
  onConnect,
  onSelectConnection,
  onEditConnection,
  onShowConnection,
  onEdit,
  onDelete,
  onClose,
  onBeginFieldEdit,
  onEndFieldEdit,
}: Props) {
  const data = useMemo(
    () => node && resolveNodeData(node.data, graph.defaults),
    [node, graph.defaults],
  );
  const rawPreview = useMemo(() => {
    if (!data) return null;
    try {
      if (isInboundKind(data.kind))
        return graph.xray ? xrayInboundConfig(data) : inboundPreview(data);
      if (isExecutableOutboundKind(data.kind))
        return graph.xray ? xrayOutboundConfig(data) : outboundBundle(data);
    } catch {
      /* Invalid drafts show their diagnostics instead. */
    }
    return null;
  }, [data, graph.xray]);
  const hintRoot = jsonArray(rawPreview) ? rawPreview[0] : rawPreview;
  const tun = !!node && isTunKind(node.data.kind);
  const adapterSettings = jsonRecord(hintRoot) ? nativeValue(hintRoot, 'settings') : undefined;
  const adapterName = jsonRecord(adapterSettings)
    ? nativeValue(adapterSettings, 'name')
    : undefined;
  if (node) node = { ...node, data: data! };
  const definition = node && getDefinition(node.data.kind);
  const connections = node
    ? graph.edges.filter(
        (connection) => connection.source === node.id || connection.target === node.id,
      )
    : [];
  const setting = (key: string, value: SettingValue) =>
    node && onUpdate(node.id, overrideSetting(node.data, key, value));
  const diagnosticRef = useRef<HTMLElement>(null);
  const request = useContext(DiagnosticFocusContext);
  useEffect(() => {
    const content = diagnosticRef.current?.querySelector<HTMLElement>('.inspector-content');
    if (content) content.scrollTop = 0;
  }, [node?.id, edge?.id]);
  useEffect(() => {
    if (request?.surface === 'inspector' && diagnosticRef.current)
      focusDiagnostic(diagnosticRef.current, request.issue);
  }, [request]);
  const nodeIssues = diagnostics.filter((issue) => issue.nodeId === node?.id);
  const autoFake = automaticFakeDns(graph);
  const autoFakeRecovery = !!node && definition?.category === 'inbound' && autoFake;
  const visibleFields =
    node && definition
      ? definition.fields.filter(
          (field) =>
            isFieldVisible(field, node.data.settings) &&
            !(autoFakeRecovery && field.key === 'sniffFakeDns') &&
            (node.data.kind === 'windivert-inbound'
              ? ['tag', 'port', 'capturePriority'].includes(field.key) ||
                !!field.section?.startsWith('sniffing') ||
                field.section === 'dnsClassification'
              : isProtocolKind(node.data.kind)
                ? field.key === 'tag'
                : isNativeConfigEditor(node.data.kind)
                  ? false
                  : isPolicyKind(node.data.kind) || node.data.kind === 'proxy-chain'
                    ? field.key === 'tag'
                    : isDnsEditor(node.data)
                      ? field.key === 'tag'
                      : node.data.kind !== 'fakedns' && !isRuleTableKind(node.data.kind)),
        )
      : [];
  const renderField = (field: SettingDefinition) => {
    const binding = bindingFor(node!.data.kind, field.key);
    return (
      <InheritableSetting
        key={node!.id + '-' + field.key}
        data={node!.data}
        defaults={graph.defaults}
        preparedRoot={hintRoot}
        field={field}
        value={node!.data.settings[field.key]}
        onReset={
          binding && graph.defaults
            ? () => onUpdate(node!.id, resetNodeDefaults(node!.data, graph.defaults!, field.key))
            : undefined
        }
        onOverride={() => setting(field.key, node!.data.settings[field.key])}
        issues={nodeIssues.filter((issue) => issue.fieldKey === field.key)}
        messagePrefix={`${node!.data.label}: `}
        onChange={(value) => setting(field.key, value)}
      />
    );
  };
  const preview =
    rawPreview && !nodeIssues.some((issue) => issue.severity === 'error')
      ? JSON.stringify(
          jsonArray(rawPreview) && rawPreview.length === 1 ? rawPreview[0] : rawPreview,
          null,
          2,
        )
      : '';
  return (
    <aside
      ref={diagnosticRef}
      className="inspector"
      aria-label="Properties"
      onFocusCapture={(e) => {
        if (e.target.matches('textarea,input:not([type=checkbox]):not([type=radio])'))
          onBeginFieldEdit?.();
      }}
      onInputCapture={(e) => {
        if (
          e.target instanceof HTMLElement &&
          e.target.matches('textarea,input:not([type=checkbox]):not([type=radio])')
        )
          onBeginFieldEdit?.();
      }}
      onBlurCapture={(e) => {
        if (e.target.matches('textarea,input:not([type=checkbox]):not([type=radio])'))
          onEndFieldEdit?.();
      }}
    >
      {!libraryEdit && (
        <div className="sidebar-heading">
          <h2>
            <SlidersHorizontal size={15} /> Properties
          </h2>
          <button className="icon-button" aria-label="Hide properties" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      )}
      {selectedCount > 1 ? (
        <div className="inspector-empty">
          <Cable size={28} />
          <h3>{selectedCount} items selected</h3>
          <button className="secondary-button" onClick={onDelete}>
            <Trash2 size={14} /> Delete selection
          </button>
        </div>
      ) : node && definition ? (
        <div className="inspector-content">
          <div className={`inspector-node-type category-${definition.category}`}>
            <span className="palette-icon">
              <NodeIcon kind={node.data.kind} />
            </span>
            <div>
              <strong>{definition.title}</strong>
              <small>{definition.group}</small>
            </div>
          </div>
          <div className="field">
            <label htmlFor="node-label">Name</label>
            <input
              id="node-label"
              autoComplete="off"
              value={tun ? (typeof adapterName === 'string' ? adapterName : '') : node.data.label}
              placeholder={tun ? captureNodeName(node.data) : undefined}
              maxLength={tun ? 100 : 128}
              disabled={tun && !jsonRecord(hintRoot)}
              onChange={(event) =>
                onUpdate(node.id, { label: boundedText(event.target.value, tun ? 100 : 128) })
              }
            />
          </div>
          {isGraphInbound(node.data.kind) && (
            <label className="inbound-enable-control">
              <input
                type="checkbox"
                checked={!isDisabledInbound(node.data)}
                onChange={(event) => onUpdate(node.id, { enabled: event.target.checked })}
              />
              Enabled
            </label>
          )}
          {!libraryEdit && node.data.stashLink && (
            <small
              className="field-help"
              title="Edits update the saved outbound and its other graph copies."
            >
              Shared with Stash
            </small>
          )}
          <NodeDescription
            key={node.id}
            value={node.data.description}
            onChange={(description) => onUpdate(node.id, { description })}
          />
          <div className="inspector-section-title">Configuration</div>
          {autoFakeRecovery && <p className="field-help">FakeDNS name recovery · Automatic</p>}
          {autoFake &&
            node.data.kind === 'direct-outbound' &&
            (String(node.data.settings.domainStrategy).startsWith('Use') ||
              ((!node.data.settings.domainStrategy ||
                node.data.settings.domainStrategy === 'AsIs') &&
                !node.data.settings.dialerProxy)) && (
              <p className="field-help">FakeDNS real-address lookup · Automatic</p>
            )}
          {node.data.native && (
            <details className="settings-section configuration-preview">
              <summary>Imported native fields</summary>
              <div className="settings-section-body">
                <p className="field-help">
                  Original imported fields. This preview may contain credentials.
                </p>
                <pre className="code-block code-block--compact" tabIndex={0}>
                  {JSON.stringify(node.data.native.original, null, 2)}
                </pre>
              </div>
            </details>
          )}
          {graph.defaults &&
            bindingsFor(node.data.kind).length > 0 &&
            !!node.data.overrides?.length && (
              <div className="notice node-defaults-summary">
                <span>
                  {node.data.overrides?.length} independent{' '}
                  {node.data.overrides?.length === 1 ? 'setting' : 'settings'}
                </span>
                <button
                  className="secondary-button button--small"
                  onClick={() => onUpdate(node.id, resetNodeDefaults(node.data, graph.defaults!))}
                >
                  Use all global defaults
                </button>
                <p className="field-help">Keeps server, account and listener settings.</p>
              </div>
            )}
          {editorAction(node.data) && (
            <button className="secondary-button node-editor-action" onClick={() => onEdit(node.id)}>
              {editorAction(node.data)}
            </button>
          )}
          {definition.sections
            ? nodeSettingGroups(definition, visibleFields).map((section) => {
                const fields = section.fields;
                if (!fields.length) return null;
                const count = nodeIssues.filter(
                  (issue) =>
                    issue.severity === 'error' &&
                    fields.some((field) => field.key === issue.fieldKey),
                ).length;
                if (section.advanced)
                  return (
                    <AdvancedSettings
                      key={`${node.id}-${section.id}`}
                      title={
                        section.title === 'Advanced'
                          ? undefined
                          : section.title.replace(/ advanced$/i, '')
                      }
                      configured={fields
                        .filter((f) =>
                          bindingFor(node.data.kind, f.key)
                            ? node.data.overrides?.includes(f.key)
                            : node.data.settings[f.key] !== f.defaultValue,
                        )
                        .map((f) => f.label)}
                      reveal={count > 0}
                    >
                      {fields.map(renderField)}
                    </AdvancedSettings>
                  );
                return (
                  <details
                    className="settings-section"
                    key={`${node.id}-${section.id}`}
                    open={!section.advanced || count > 0}
                  >
                    <summary>
                      <ChevronRight size={13} />
                      <span>{section.title}</span>
                      {count > 0 && <b>{count}</b>}
                      {section.advanced && <small>advanced</small>}
                    </summary>
                    <div className="settings-section-body">
                      {section.description && (
                        <p className="section-description">{section.description}</p>
                      )}
                      {fields.map(renderField)}
                    </div>
                  </details>
                );
              })
            : visibleFields.map(renderField)}
          {node.data.kind === 'proxy-inbound' &&
            hintRoot &&
            (() => {
              const field = definition.fields.find((f) => f.key === 'streamSettings')!;
              const inherited = settingDefaultState(
                node.data,
                field,
                graph.defaults,
                hintRoot,
              ).inherited;
              return (
                <InboundSocketBuffers
                  key={`buffers-${node.id}`}
                  input={inherited ? { ...hintRoot, streamSettings: {} } : hintRoot}
                  effective={hintRoot}
                  globalDefaults={graph.defaults}
                  onChange={(sockopt) => {
                    const stream = nativeValue(hintRoot, 'streamSettings');
                    setting(
                      'streamSettings',
                      JSON.stringify(
                        setNative(
                          jsonRecord(stream) ? stream : {},
                          'sockopt',
                          Object.keys(sockopt).length ? sockopt : undefined,
                        ),
                        null,
                        2,
                      ),
                    );
                  }}
                />
              );
            })()}
          {isInboundKind(node.data.kind) && !isProtocolInbound(node.data.kind) && (
            <div className="condition-explanation">
              <strong>Data / DNS paths</strong>
              <p>
                DNS classifies requests that reach this listener on the configured plain DNS ports.
                Windows DNS needs capture or an explicit proxy-aware client.
              </p>
              <p>
                Encrypted DNS stays encrypted and follows its separate connection when configured.
              </p>
            </div>
          )}
          {(isExecutableOutboundKind(node.data.kind) || isInboundKind(node.data.kind)) && (
            <details className="settings-section configuration-preview" key={`${node.id}-preview`}>
              <summary>
                <ChevronRight size={13} />
                <span>
                  {definition.group === 'Local capture'
                    ? 'Capture'
                    : isInboundKind(node.data.kind)
                      ? 'Inbound'
                      : 'Outbound'}{' '}
                  JSON preview
                </span>
              </summary>
              <div className="settings-section-body">
                <p className="field-help">
                  {definition.group === 'Local capture'
                    ? 'Core configuration for this capture source; compile the graph for complete routing.'
                    : isInboundKind(node.data.kind)
                      ? 'This listener only; Data/DNS paths are graph routing rules, separate from the inbound settings.'
                      : 'This destination and any required fragmentation wrapper; compile the graph for complete routing.'}{' '}
                  The preview includes configured credentials.
                </p>
                {preview ? (
                  <pre className="code-block code-block--compact" tabIndex={0}>
                    {preview}
                  </pre>
                ) : (
                  <p className="field-message error">
                    Correct the configuration issues to view the preview.
                  </p>
                )}
              </div>
            </details>
          )}
          {!libraryEdit && (
            <>
              <div className="inspector-section-title">
                Connections <span>{connections.length}</span>
              </div>
              {node.data.kind !== 'xray-dns-servers' &&
                getOutputPorts(node.data.kind, node.data)
                  .filter(
                    (port) =>
                      !connections.some(
                        (connection) =>
                          connection.source === node.id && connection.sourceHandle === port,
                      ),
                  )
                  .map((port) => (
                    <div className="connection-output" key={port}>
                      <span>
                        {portLabel(port, node.data)}
                        <small>
                          {connectionTypes[sourceConnectionKind(node.data, port)].label} · Not
                          connected
                        </small>
                      </span>
                      <button
                        className="secondary-button"
                        onClick={() => onConnect(node.id, port)}
                        aria-label={`Connect ${node.data.label} / ${portLabel(port, node.data)}`}
                      >
                        Connect…
                      </button>
                    </div>
                  ))}
              {!connections.length && !getOutputPorts(node.data.kind, node.data).length && (
                <p className="muted-note">
                  No incoming connections. Use Add connection to choose a source.
                </p>
              )}
              {connections.map((connection) => {
                const outgoing = connection.source === node.id;
                const source = graph.nodes.find((item) => item.id === connection.source);
                const role =
                  source &&
                  connectionTypes[sourceConnectionKind(source.data, connection.sourceHandle ?? '')];
                return (
                  <button
                    className="connection-item connection-list-item"
                    key={connection.id}
                    onClick={() => onSelectConnection(connection.id)}
                    aria-label={`Inspect connection: ${connectionDescription(graph, connection)}`}
                  >
                    {outgoing ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                    <span>
                      <strong>{connectionDescription(graph, connection)}</strong>
                      <small>
                        {outgoing ? 'Outgoing' : 'Incoming'} · {role?.label ?? 'Unknown role'}
                        {!connectionIsEditable(graph, connection) ? ' · Generated' : ''}
                      </small>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                );
              })}
              <button
                className="secondary-button compact-controls button--danger delete-node-button"
                onClick={onDelete}
              >
                <Trash2 size={14} /> Delete node
              </button>
            </>
          )}
        </div>
      ) : edge ? (
        <div className="inspector-content">
          <div className="inspector-section-title" id="selected-connection-heading" tabIndex={-1}>
            Connection
          </div>
          <p className="muted-note">{connectionDescription(graph, edge)}</p>
          {(() => {
            const source = graph.nodes.find((item) => item.id === edge.source);
            const role =
              source && connectionTypes[sourceConnectionKind(source.data, edge.sourceHandle ?? '')];
            return (
              role && (
                <span className="connection-role" style={{ color: role.color }}>
                  {role.label}
                </span>
              )
            );
          })()}
          <button
            className="secondary-button connection-endpoint"
            onClick={() => onSelect(edge.source)}
          >
            Source:{' '}
            {graph.nodes.find((item) => item.id === edge.source)?.data.label ?? 'Missing node'} /{' '}
            {portLabel(
              edge.sourceHandle ?? '',
              graph.nodes.find((item) => item.id === edge.source)?.data,
            )}
          </button>
          <button
            className="secondary-button connection-endpoint"
            onClick={() => onSelect(edge.target)}
          >
            Destination:{' '}
            {graph.nodes.find((item) => item.id === edge.target)?.data.label ?? 'Missing node'} /
            Input
          </button>
          <div className="connection-actions">
            <button className="secondary-button" onClick={() => onShowConnection(edge.id)}>
              Show endpoints
            </button>
            <button
              className="primary-button"
              disabled={!connectionIsEditable(graph, edge)}
              onClick={() => onEditConnection(edge.id)}
            >
              Edit connection…
            </button>
          </div>
          {!connectionIsEditable(graph, edge) && (
            <p className="muted-note">
              This query path is generated by Xray DNS settings. Edit the DNS servers to change it.
            </p>
          )}
          <button
            className="secondary-button compact-controls button--danger delete-node-button"
            disabled={!connectionIsEditable(graph, edge)}
            onClick={onDelete}
          >
            <Trash2 size={14} /> Delete connection
          </button>
        </div>
      ) : (
        <div className="inspector-empty">
          <SlidersHorizontal size={30} />
          <h3>Select a node or connection</h3>
        </div>
      )}
    </aside>
  );
}

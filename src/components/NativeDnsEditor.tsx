import useEditorSave from './useEditorSave';
import InvalidSettings from './InvalidSettings';
import { focusDiagnostic } from './DiagnosticNavigation';
import { isUdpResolver, tcpResolverAddress, udpDnsPolicyWarnings } from '../graph/dnsTransport';
import { boundedText } from '../text';
import { EditorTabs, EditorTabPanel, useEditorTabs } from './EditorTabs';
import { useRequestedDiagnostic } from './DiagnosticNavigation';
import useModalDialog from './useModalDialog';
import useFieldValidity from './useFieldValidity';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { dnsHandlerFields, dnsServerFields } from '../graph/nativeFields';
import { nativeJson, nativeOutputs, nativeProblems } from '../graph/xrayNodes';
import { jsonRecord, parseXrayJson, jsonText, jsonArray } from '../graph/xrayJson';
import type { GraphState, RuleNode, RuleNodeData } from '../graph/types';
import NativeObjectFields from './NativeObjectFields';

export default function NativeDnsEditor({
  node,
  graph,
  onApply,
  onClose,
}: {
  node: RuleNode;
  graph: GraphState;
  onApply: (id: string, data: Partial<RuleNodeData>) => void;
  onClose: () => void;
}) {
  const { save, saveError } = useEditorSave(onClose);
  const requested = useRequestedDiagnostic();
  const handler = node.data.kind === 'xray-dns',
    dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => nativeJson(node.data)),
    [raw, setRaw] = useState(String(node.data.settings.json)),
    [rawError, setRawError] = useState(''),
    [tab, setTab] = useState<'fields' | 'json'>(requested?.fieldKey === 'json' ? 'json' : 'fields'),
    [selected, setSelected] = useState(0);
  const [outputs, setOutputs] = useState(() => nativeOutputs(node.data));
  const { invalid, report: validity, blocked: fieldsBlocked } = useFieldValidity();
  const [formRevision, setFormRevision] = useState(0);
  const handlerNode = graph.nodes.find((n) => n.data.kind === 'xray-dns');
  const parent = handlerNode ? nativeJson(handlerNode.data) : {};
  const servers = jsonArray(draft.servers) ? draft.servers : [];
  const change = (value: Record<string, unknown>) => {
    setDraft(value);
    setRaw(JSON.stringify(value, null, 2));
    setRawError('');
  };
  const textChange = (value: string) => {
    setRaw(value);
    try {
      const parsed = parseXrayJson(value);
      if (!jsonRecord(parsed)) throw new Error('Use a JSON object.');
      setDraft(parsed);
      setFormRevision((revision) => revision + 1);
      setSelected(0);
      setRawError('');
    } catch (e) {
      setRawError(e instanceof Error ? e.message : 'Invalid JSON.');
    }
  };
  const data = {
      ...node.data,
      settings: {
        ...node.data.settings,
        json: rawError ? raw : JSON.stringify(draft, null, 2),
        ...(handler ? { outputs: JSON.stringify(outputs) } : {}),
      },
    },
    issues = nativeProblems(data),
    blocked =
      !!rawError ||
      Object.values(invalid).some(Boolean) ||
      issues.some((i) => i.severity === 'error');
  const tabs = useEditorTabs(
    [
      { key: 'fields', label: 'Settings' },
      { key: 'json', label: 'Native JSON' },
    ],
    tab,
    setTab,
  );
  useModalDialog(dialog);
  const row = servers[selected],
    object = jsonRecord(row) ? row : { address: typeof row === 'string' ? row : '' };
  const updateServer = (value: Record<string, unknown>) => {
    // Address-only edits retain a native string server. Any additional option
    // deliberately converts that entry into the object form required by Xray.
    const next =
      typeof row === 'string' &&
      Object.keys(value).length === 1 &&
      typeof value.address === 'string'
        ? value.address
        : value;
    change({ ...draft, servers: servers.map((s, i) => (i === selected ? next : s)) });
  };
  function move(delta: number) {
    const next = [...servers];
    [next[selected], next[selected + delta]] = [next[selected + delta], next[selected]];
    change({ ...draft, servers: next });
    setSelected(selected + delta);
  }
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window"
      aria-labelledby="native-dns-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="native-dns-title">
            {handler ? 'DNS handler' : 'DNS server(s)'} · {node.data.label}
          </h2>
        </div>
        <button className="icon-button" aria-label="Close DNS editor" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <EditorTabs tabs={tabs} label="DNS sections" />
      <EditorTabPanel
        key={`fields-${formRevision}`}
        tabs={tabs}
        tab="fields"
        className="runtime-body"
      >
        {handler ? (
          <>
            <NativeObjectFields
              object={draft}
              fields={dnsHandlerFields}
              structure="DNSConfig"
              idPrefix="native-dns"
              onChange={change}
              onValidity={validity}
            />
            <h3>Ordered resolver outputs</h3>
            <p className="runtime-scope">
              Output order becomes the core’s server-list order. Domain preferences and fallback run
              according to Xray’s DNS selection rules.
            </p>
            <div className="runtime-actions">
              <button
                className="secondary-button"
                disabled={outputs.length >= 128}
                onClick={() =>
                  setOutputs([
                    ...outputs,
                    { id: crypto.randomUUID(), name: `Server ${outputs.length + 1}` },
                  ])
                }
              >
                <Plus size={14} /> Add resolver output
              </button>
            </div>
            {outputs.map((output, i) => (
              <div className="runtime-actions" key={output.id}>
                <label className="editor-field">
                  <span>Resolver output {i + 1}</span>
                  <input
                    value={output.name}
                    onChange={(e) =>
                      setOutputs(
                        outputs.map((o) =>
                          o.id === output.id ? { ...o, name: boundedText(e.target.value, 128) } : o,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  className="icon-button"
                  aria-label={`Move resolver output ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => {
                    const next = [...outputs];
                    [next[i], next[i - 1]] = [next[i - 1], next[i]];
                    setOutputs(next);
                  }}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move resolver output ${i + 1} down`}
                  disabled={i === outputs.length - 1}
                  onClick={() => {
                    const next = [...outputs];
                    [next[i], next[i + 1]] = [next[i + 1], next[i]];
                    setOutputs(next);
                  }}
                >
                  <ArrowDown size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove resolver output ${i + 1}`}
                  onClick={() => setOutputs(outputs.filter((o) => o.id !== output.id))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <p className="runtime-scope">
              Connect each output to a DNS server(s) node. Removing an output removes its connection
              when these settings are applied.
            </p>
          </>
        ) : (
          <>
            <div className="runtime-actions">
              <label className="editor-field">
                <span>Server entry</span>
                <select
                  aria-label="Server entry"
                  value={selected}
                  disabled={fieldsBlocked}
                  aria-describedby={fieldsBlocked ? 'dns-entry-error' : undefined}
                  onChange={(e) => {
                    if (!fieldsBlocked) setSelected(Number(e.target.value));
                  }}
                >
                  {servers.map((s, i) => (
                    <option key={i} value={i}>
                      {i + 1}.{' '}
                      {typeof s === 'string'
                        ? s
                        : jsonRecord(s)
                          ? jsonText(s.address ?? 'Unset')
                          : 'Invalid entry'}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="icon-button"
                aria-label="Add server"
                title="Add server"
                disabled={servers.length >= 128 || blocked}
                onClick={() => {
                  change({ ...draft, servers: [...servers, '1.1.1.1'] });
                  setSelected(servers.length);
                }}
              >
                <Plus size={16} />
              </button>
              <button
                className="secondary-button"
                disabled={servers.length <= 1 || blocked}
                onClick={() => {
                  change({ ...draft, servers: servers.filter((_, i) => i !== selected) });
                  setSelected(Math.max(0, selected - 1));
                }}
              >
                <Trash2 size={14} /> Remove
              </button>
              <button
                className="icon-button"
                aria-label="Move DNS server up"
                disabled={selected <= 0 || blocked}
                onClick={() => move(-1)}
              >
                <ArrowUp size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Move DNS server down"
                disabled={selected >= servers.length - 1 || blocked}
                onClick={() => move(1)}
              >
                <ArrowDown size={16} />
              </button>
            </div>
            {fieldsBlocked && (
              <p className="field-message error" id="dns-entry-error">
                Correct invalid fields before changing entries.
              </p>
            )}
            {row !== undefined && (
              <NativeObjectFields
                key={selected}
                object={object}
                fields={dnsServerFields}
                structure="NameServerConfig"
                parent={parent}
                idPrefix={`resolver-${selected}`}
                onChange={updateServer}
                onValidity={validity}
              />
            )}
            {row !== undefined && isUdpResolver(jsonText(object.address ?? '')) && (
              <div className="dns-transport-action">
                {udpDnsPolicyWarnings(graph).some((i) => i.nodeId === node.id) && (
                  <p className="editor-note">
                    UDP DNS can keep a failed policy route. TCP DNS follows the current candidate on
                    each request.
                  </p>
                )}
                <button
                  className="secondary-button"
                  disabled={blocked}
                  onClick={() =>
                    updateServer({
                      ...object,
                      address: tcpResolverAddress(
                        String(object.address),
                        Number(object.port ?? 53),
                      ),
                    })
                  }
                >
                  Use TCP DNS
                </button>
              </div>
            )}
            <p className="runtime-scope">
              UDP/TCP/DoH queries use the graph’s global routing rules. localhost and +local
              transports use their native local bypass. Named preferences are resolver choices,
              rather than first-match traffic rules.
            </p>
          </>
        )}
      </EditorTabPanel>
      <EditorTabPanel tabs={tabs} tab="json" className="runtime-body">
        <label className="editor-field">
          <span>Native DNS options (JSON)</span>
          <textarea
            rows={18}
            spellCheck={false}
            data-diagnostic-field="json"
            value={raw}
            onChange={(e) => textChange(e.target.value)}
          />
        </label>
      </EditorTabPanel>
      <InvalidSettings
        invalid={invalid}
        fields={[...dnsHandlerFields, ...dnsServerFields]}
        onReview={(id) => {
          setTab('fields');
          requestAnimationFrame(() => {
            if (dialog.current)
              focusDiagnostic(dialog.current, { severity: 'error', message: '', controlId: id });
          });
        }}
      />
      {(rawError || issues.length > 0) && (
        <div className="rule-editor-diagnostics" role="alert">
          {rawError && <p className="error">{rawError}</p>}
          {issues.map((i, k) => (
            <p key={k} className={i.severity}>
              {i.message}
            </p>
          ))}
        </div>
      )}
      {saveError && (
        <p className="runtime-error" role="alert">
          {saveError}
        </p>
      )}
      <div className="rule-editor-footer">
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={blocked}
          onClick={() => save(() => onApply(node.id, { settings: data.settings }))}
        >
          Apply DNS settings
        </button>
      </div>
    </dialog>
  );
}

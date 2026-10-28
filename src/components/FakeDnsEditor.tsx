import useEditorSave from './useEditorSave';
import InvalidSettings from './InvalidSettings';
import { focusDiagnostic } from './DiagnosticNavigation';
import AdvancedSettings from './AdvancedSettings';
import { EditorTabs, EditorTabPanel, useEditorTabs } from './EditorTabs';
import useModalDialog from './useModalDialog';
import { Plus, Trash2, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { automaticFakeDnsPools, editFakeDnsGraph, fakeDnsNodeProblems } from '../graph/fakeDns';
import { dnsServerFields, type NativeField } from '../graph/nativeFields';
import { jsonRecord, parseXrayJson, jsonText, jsonArray } from '../graph/xrayJson';
import { compileRuntimeGraph } from '../graph/runtime';
import type { GraphState, RuleNode } from '../graph/types';
import NativeObjectFields from './NativeObjectFields';

const poolFields: NativeField[] = [
  {
    key: 'ipPool',
    label: 'Address pool (CIDR)',
    type: 'text',
    coreKey: 'FakeDNSPoolElementConfig.ipPool',
  },
  {
    key: 'poolSize',
    label: 'Mapping capacity',
    type: 'integer',
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    coreKey: 'FakeDNSPoolElementConfig.poolSize',
  },
];
const decode = (text: string, fallback: unknown) => {
  try {
    return parseXrayJson(text);
  } catch {
    return fallback;
  }
};
export default function FakeDnsEditor({
  node,
  graph,
  onApply,
  onClose,
}: {
  node: RuleNode;
  graph: GraphState;
  onApply: (id: string, data: Partial<RuleNode['data']>) => void;
  onClose: () => void;
}) {
  const { save, saveError } = useEditorSave(onClose);
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState({ ...node.data.settings });
  const [tab, setTab] = useState('pools'),
    [selected, setSelected] = useState(0);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const validity = useCallback(
    (id: string, valid: boolean) =>
      setInvalid((p) => (p[id] === !valid ? p : { ...p, [id]: !valid })),
    [],
  );
  const tabs = useEditorTabs(
    [
      ['pools', 'Shared pools'],
      ['resolver', 'Resolver preferences'],
      ['json', 'Native JSON'],
      ['preview', 'Xray preview'],
    ].map(([key, label]) => ({ key, label })),
    tab,
    setTab,
  );
  useModalDialog(dialog);
  const raw = String(settings.pools),
    automatic = !raw.trim();
  const parsed = decode(raw, []),
    pools = jsonArray(parsed) ? parsed : [parsed];
  const serverValue = decode(String(settings.servers), []),
    servers = jsonArray(serverValue) ? serverValue : [];
  const dnsNode = graph.nodes.find((n) => ['dns-handler', 'xray-dns'].includes(n.data.kind));
  const handler =
    dnsNode?.data.kind === 'xray-dns' ? decode(String(dnsNode.data.settings.json), {}) : undefined;
  const family = jsonRecord(handler)
    ? jsonText(handler.queryStrategy ?? 'UseIP')
    : String(dnsNode?.data.settings.queryStrategy ?? 'UseIP');
  const corePools = automaticFakeDnsPools(family);
  const change = (key: string, value: string) => setSettings((p) => ({ ...p, [key]: value }));
  const issues = fakeDnsNodeProblems({ ...node.data, settings });
  const blocked =
    issues.some((i) => i.severity === 'error') || Object.values(invalid).some(Boolean);
  const poolChange = (index: number, row: Record<string, unknown>) => {
    const next = pools.map((p, i) => (i === index ? row : p));
    change('pools', JSON.stringify(jsonArray(parsed) ? next : next[0], null, 2));
  };
  const row = servers[selected],
    object = jsonRecord(row) ? row : { address: typeof row === 'string' ? row : 'fakedns' };
  let preview: string;
  try {
    preview = JSON.stringify(
      compileRuntimeGraph(editFakeDnsGraph(graph, node.id, settings)).config,
      null,
      2,
    );
  } catch (e) {
    preview = e instanceof Error ? e.message : 'Complete the graph before compiling.';
  }
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window"
      aria-labelledby="fakedns-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="fakedns-title">Edit FakeDNS · {node.data.label}</h2>
        </div>
        <button className="icon-button" aria-label="Close FakeDNS editor" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <EditorTabs tabs={tabs} label="FakeDNS sections" />
      <EditorTabPanel tabs={tabs} tab="pools" className="runtime-body">
        <label className="check-control">
          <input
            type="checkbox"
            checked={automatic}
            onChange={(e) =>
              change('pools', e.target.checked ? '' : JSON.stringify(corePools, null, 2))
            }
          />
          Use Xray’s automatic pools
        </label>
        <p className="runtime-scope">
          The DNS handler selects {family}. Its automatic pools are{' '}
          {corePools
            .map((p) => `${p.ipPool} (${p.poolSize.toLocaleString()} mappings)`)
            .join(' and ')}
          .
        </p>
        <AdvancedSettings title="Pool tuning" configured={automatic ? [] : ['Custom pools']}>
          {!automatic && (
            <>
              {pools.map((p, index) => (
                <section className="fakedns-pool" key={index}>
                  <div className="section-heading">
                    <h3>Pool {index + 1}</h3>
                    <button
                      className="icon-button"
                      aria-label={`Remove pool ${index + 1}`}
                      disabled={pools.length === 1}
                      onClick={() =>
                        change(
                          'pools',
                          JSON.stringify(
                            pools.filter((_, i) => i !== index),
                            null,
                            2,
                          ),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <NativeObjectFields
                    object={jsonRecord(p) ? p : {}}
                    fields={poolFields}
                    idPrefix={`fake-pool-${index}`}
                    onValidity={validity}
                    onChange={(o) => poolChange(index, o)}
                  />
                </section>
              ))}
              <button
                className="secondary-button"
                disabled={pools.length >= 32}
                onClick={() =>
                  change(
                    'pools',
                    JSON.stringify(
                      [...pools, { ipPool: corePools[0].ipPool, poolSize: corePools[0].poolSize }],
                      null,
                      2,
                    ),
                  )
                }
              >
                <Plus size={16} />
                Add pool
              </button>
            </>
          )}
        </AdvancedSettings>
        <p className="runtime-scope">
          Apply updates shared pools in every FakeDNS node together. Domain mappings live in the
          running core and are cleared when it restarts.
        </p>
        <p className="runtime-scope">
          Enable FakeDNS domain recovery on inputs that receive traffic to synthetic addresses. This
          node does not capture Windows DNS or change adapter settings.
        </p>
      </EditorTabPanel>
      <EditorTabPanel tabs={tabs} tab="resolver" className="runtime-body">
        {servers.length > 0 ? (
          <>
            <label className="editor-field">
              <span>Resolver entry</span>
              <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
                {servers.map((_, i) => (
                  <option key={i} value={i}>
                    FakeDNS {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <NativeObjectFields
              object={object}
              fields={dnsServerFields.filter(
                (f) => !['address', 'port', 'clientIp'].includes(f.key),
              )}
              structure="NameServerConfig"
              idPrefix={`fake-server-${selected}`}
              onValidity={validity}
              onChange={(o) =>
                change(
                  'servers',
                  JSON.stringify(
                    servers.map((s, i) => (i === selected ? o : s)),
                    null,
                    2,
                  ),
                )
              }
            />
          </>
        ) : (
          <>
            <p>
              This imported node only defines pools. Add a resolver entry to use it from a DNS
              handler.
            </p>
            <button className="secondary-button" onClick={() => change('servers', '["fakedns"]')}>
              Add resolver entry
            </button>
          </>
        )}
        <p className="runtime-scope">
          FakeDNS uses resolver-selection connections and has no network query output. In an
          authored graph, a connected DNS routing filter supplies domain preferences for each of its
          rules.
        </p>
      </EditorTabPanel>
      <EditorTabPanel tabs={tabs} tab="json" className="runtime-body">
        <label className="editor-field">
          <span>Shared pools JSON · blank uses core defaults</span>
          <textarea rows={8} value={raw} onChange={(e) => change('pools', e.target.value)} />
        </label>
        <label className="editor-field">
          <span>Resolver entries JSON</span>
          <textarea
            rows={8}
            value={String(settings.servers)}
            onChange={(e) => change('servers', e.target.value)}
          />
        </label>
      </EditorTabPanel>
      <EditorTabPanel tabs={tabs} tab="preview" className="runtime-body">
        <pre className="code-block" tabIndex={0} aria-label="Xray configuration preview">
          {preview}
        </pre>
      </EditorTabPanel>
      <InvalidSettings
        invalid={invalid}
        fields={[...poolFields, ...dnsServerFields]}
        onReview={(id) => {
          setTab(id.startsWith('fake-pool-') ? 'pools' : 'resolver');
          requestAnimationFrame(() => {
            if (dialog.current)
              focusDiagnostic(dialog.current, { severity: 'error', message: '', controlId: id });
          });
        }}
      />
      {issues.length > 0 && (
        <div className="rule-editor-diagnostics" role="alert">
          {issues.map((i, k) => (
            <p key={k} className={i.severity}>
              {i.message}
            </p>
          ))}
        </div>
      )}
      {saveError && (
        <p className="notice notice--error" role="alert">
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
          onClick={() => save(() => onApply(node.id, { settings }))}
        >
          Apply FakeDNS settings
        </button>
      </div>
    </dialog>
  );
}

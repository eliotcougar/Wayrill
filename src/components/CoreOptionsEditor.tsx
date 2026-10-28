import useEditorSave from './useEditorSave';
import InvalidSettings from './InvalidSettings';
import { focusDiagnostic } from './DiagnosticNavigation';
import AdvancedSettings from './AdvancedSettings';
import { EditorTabs, EditorTabPanel, useEditorTabs } from './EditorTabs';
import useModalDialog from './useModalDialog';
import useFieldValidity from './useFieldValidity';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  logFields,
  metricsFields,
  routingOptionFields,
  policyLevelFields,
  policySystemFields,
} from '../graph/nativeFields';
import { nativeJson, nativeProblems } from '../graph/xrayNodes';
import { jsonRecord, parseXrayJson } from '../graph/xrayJson';
import type { RuleNode, RuleNodeData } from '../graph/types';
import NativeObjectFields from './NativeObjectFields';
import PolicyFields from './PolicyFields';

export default function CoreOptionsEditor({
  node,
  onApply,
  onClose,
}: {
  node: RuleNode;
  onApply: (id: string, data: Partial<RuleNodeData>) => void;
  onClose: () => void;
}) {
  const { save, saveError } = useEditorSave(onClose);
  const dialog = useRef<HTMLDialogElement>(null),
    [draft, setDraft] = useState(() => nativeJson(node.data)),
    [raw, setRaw] = useState(String(node.data.settings.json)),
    [rawError, setRawError] = useState(''),
    [tab, setTab] = useState('general'),
    [formRevision, setFormRevision] = useState(0);
  const { invalid, report: validity } = useFieldValidity();
  const object = (key: string) => (jsonRecord(draft[key]) ? draft[key] : {});
  const change = (value: Record<string, unknown>) => {
    setDraft(value);
    setRaw(JSON.stringify(value, null, 2));
    setRawError('');
  };
  const section = (key: string, value: Record<string, unknown>) =>
    change({ ...draft, [key]: value });
  const toggle = (key: string, enabled: boolean) => {
    const next = { ...draft };
    if (enabled) next[key] = {};
    else delete next[key];
    change(next);
  };
  const data = {
      ...node.data,
      settings: { ...node.data.settings, json: rawError ? raw : JSON.stringify(draft, null, 2) },
    },
    issues = nativeProblems(data),
    blocked =
      !!rawError ||
      Object.values(invalid).some(Boolean) ||
      issues.some((i) => i.severity === 'error');
  const tabs = useEditorTabs(
    [
      ['general', 'Logging & routing'],
      ['policy', 'Policy levels'],
      ['metrics', 'Statistics & metrics'],
      ['json', 'Native JSON'],
    ].map(([key, label]) => ({ key, label })),
    tab,
    setTab,
  );
  useModalDialog(dialog);
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window"
      aria-labelledby="core-options-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="core-options-title">Xray core options</h2>
        </div>
        <button className="icon-button" aria-label="Close core options" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <EditorTabs tabs={tabs} label="Core options sections" />
      <EditorTabPanel
        key={`general-${formRevision}`}
        tabs={tabs}
        tab="general"
        className="runtime-body"
      >
        <h3>Logging</h3>
        <NativeObjectFields
          object={object('log')}
          fields={logFields}
          structure="LogConfig"
          idPrefix="native-log"
          onValidity={validity}
          onChange={(o) => section('log', o)}
        />
        <h3>Routing defaults</h3>
        <NativeObjectFields
          object={object('routing')}
          fields={routingOptionFields}
          structure="RouterConfig"
          idPrefix="native-routing"
          onValidity={validity}
          onChange={(o) => section('routing', o)}
        />
        <p className="runtime-scope">
          The service chooses log destinations. These values also populate the workspace’s global
          core settings.
        </p>
      </EditorTabPanel>
      <EditorTabPanel
        key={`policy-${formRevision}`}
        tabs={tabs}
        tab="policy"
        className="runtime-body"
      >
        <AdvancedSettings
          title="Core policy"
          configured={Object.hasOwn(draft, 'policy') ? ['Core policy'] : []}
        >
          <label className="editor-checkbox">
            <input
              type="checkbox"
              checked={Object.hasOwn(draft, 'policy')}
              onChange={(e) => toggle('policy', e.target.checked)}
            />{' '}
            Configure core policy
          </label>
          {Object.hasOwn(draft, 'policy') && (
            <PolicyFields
              policy={object('policy')}
              idPrefix="native-policy"
              onValidity={validity}
              onChange={(o) => section('policy', o)}
            />
          )}
        </AdvancedSettings>
      </EditorTabPanel>
      <EditorTabPanel
        key={`metrics-${formRevision}`}
        tabs={tabs}
        tab="metrics"
        className="runtime-body"
      >
        <label className="editor-checkbox">
          <input
            type="checkbox"
            checked={Object.hasOwn(draft, 'stats')}
            onChange={(e) => toggle('stats', e.target.checked)}
          />{' '}
          Enable core statistics module
        </label>
        <p className="runtime-scope">
          Policy levels configure exported counters. Wayrill collects live inbound/outbound
          statistics automatically; open View → Traffic statistics.
        </p>
        <AdvancedSettings
          title="Metrics"
          configured={Object.hasOwn(draft, 'metrics') ? ['Metrics'] : []}
        >
          <label className="editor-checkbox">
            <input
              type="checkbox"
              checked={Object.hasOwn(draft, 'metrics')}
              onChange={(e) => {
                if (e.target.checked) section('metrics', { tag: 'metrics' });
                else toggle('metrics', false);
              }}
            />{' '}
            Enable metrics
          </label>
          {Object.hasOwn(draft, 'metrics') && (
            <NativeObjectFields
              object={object('metrics')}
              fields={metricsFields}
              idPrefix="native-metrics"
              onValidity={validity}
              onChange={(o) => section('metrics', o)}
            />
          )}
          <p className="runtime-scope">
            A metrics listener must use an unused loopback port of at least 1024 to run through the
            Windows service. Tag-only metrics retain the imported routing arrangement.
          </p>
        </AdvancedSettings>
      </EditorTabPanel>
      <EditorTabPanel tabs={tabs} tab="json" className="runtime-body">
        <label className="editor-field">
          <span>Additional native root options</span>
          <textarea
            rows={19}
            spellCheck={false}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              try {
                const value = parseXrayJson(e.target.value);
                if (!jsonRecord(value)) throw new Error('Use a JSON object.');
                setDraft(value);
                setFormRevision((revision) => revision + 1);
                setRawError('');
              } catch (error) {
                setRawError(error instanceof Error ? error.message : 'Invalid JSON.');
              }
            }}
          />
        </label>
        <p className="runtime-scope">
          Native extensions are retained. Inbounds, outbounds, DNS, observatories and routing rules
          belong in their graph nodes.
        </p>
      </EditorTabPanel>
      <InvalidSettings
        invalid={invalid}
        fields={[
          ...logFields,
          ...routingOptionFields,
          ...metricsFields,
          ...policyLevelFields,
          ...policySystemFields,
        ]}
        onReview={(id) => {
          setTab(
            id.startsWith('native-policy-')
              ? 'policy'
              : id.startsWith('native-metrics-')
                ? 'metrics'
                : 'general',
          );
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
          onClick={() => save(() => onApply(node.id, { settings: data.settings }))}
        >
          Apply core settings
        </button>
      </div>
    </dialog>
  );
}

import useEditorSave from './useEditorSave';
import AdvancedSettings from './AdvancedSettings';
import { basicGlobalSettings } from '../graph/settingsLayout';
import TrafficUnitSettings from './TrafficUnitSettings';
import ResourceFields from './ResourceFields';
import { factoryResources } from '../graph/resources';
import DiagnosticList, {
  useRequestedDiagnostic,
  useLocalDiagnosticFocus,
  draftNumberIssues,
} from './DiagnosticNavigation';
import useModalDialog from './useModalDialog';
import useFieldValidity from './useFieldValidity';
import { Search, Settings2, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyDefaults,
  bindingsFor,
  defaultSections,
  defaultsProblems,
  factoryDefaults,
  globalFields,
  resetCoreDefault,
} from '../graph/defaults';
import { diagnoseGraph } from '../graph/model';
import { largeGraph } from '../graph/analysis';
import useGraphAnalysis from '../useGraphAnalysis';
import type { Diagnostic, GlobalDefaults, GraphState, SettingValue } from '../graph/types';
import { SettingField } from './SettingField';
import {
  coreDefaultField,
  coreDefaultHint,
  configuredDefaultHint,
  embeddedCoreDefaults,
} from '../graph/coreDefaults';
import PolicyFields from './PolicyFields';
import { jsonRecord, parseJson } from '../graph/xrayJson';

export default function GlobalDefaultsEditor({
  graph,
  onApply,
  onClose,
  initialSection,
}: {
  initialSection?: string;
  graph: GraphState;
  onApply: (defaults: GlobalDefaults) => void;
  onClose: () => void;
}) {
  const { save, saveError } = useEditorSave(onClose);
  const requested = useRequestedDiagnostic();
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<GlobalDefaults>(() =>
    structuredClone(graph.defaults ?? factoryDefaults()),
  );
  const [section, setSection] = useState<string>(
    globalFields.find((f) => f.key === requested?.fieldKey)?.section ??
      (requested?.fieldKey === 'resources' ? 'resources' : (initialSection ?? 'inputs')),
  );
  const [search, setSearch] = useState('');
  const { invalid: invalidPolicy, report: policyValidity } = useFieldValidity();
  const [policyRevision, setPolicyRevision] = useState(0);
  const resetPolicyDraft = (key?: string) => {
    if (!key || key === 'policy') setPolicyRevision((revision) => revision + 1);
  };
  let policy: Record<string, unknown> | null = null;
  try {
    const value: unknown = parseJson(String(draft.settings.policy || '{}'));
    if (jsonRecord(value)) policy = value;
  } catch {
    /* The JSON field explains syntax errors. */
  }
  const numericIssues = draftNumberIssues(invalidPolicy, globalFields).map((issue) => ({
    ...issue,
    fieldKey: globalFields.find((f) => issue.controlId?.endsWith(`-${f.key}`))?.key ?? 'policy',
  }));
  const issues = [...defaultsProblems(draft), ...numericIssues];
  const errors = issues.filter((i) => i.severity === 'error');
  const changed =
    globalFields.filter(
      (f) => draft.settings[f.key] !== (graph.defaults ?? factoryDefaults()).settings[f.key],
    ).length +
    (JSON.stringify(draft.resources ?? factoryResources()) !==
    JSON.stringify(graph.defaults?.resources ?? factoryResources())
      ? 1
      : 0);
  const overridden = graph.nodes.reduce((n, node) => n + (node.data.overrides?.length ?? 0), 0);
  const affected = graph.nodes.filter((node) =>
    globalFields.some(
      (f) =>
        draft.settings[f.key] !== graph.defaults?.settings[f.key] &&
        bindingsFor(node.data.kind).some(
          (b) => b.key === f.key && !node.data.overrides?.includes(b.nodeKey),
        ),
    ),
  ).length;
  const large = largeGraph(graph);
  const previewGraph = useMemo(
    () => (errors.length ? graph : applyDefaults(graph, draft)),
    [graph, draft, errors.length],
  );
  const analysis = useGraphAnalysis(previewGraph, large && !errors.length, 'nodes');
  const inheritedErrors = useMemo(() => {
    if (errors.length) return [];
    const issues = large ? analysis.issues : diagnoseGraph(previewGraph);
    return issues.filter((i) => i.severity === 'error' && i.nodeId);
  }, [previewGraph, errors.length, large, analysis.issues]);
  const checkFailure = large && analysis.issues.find((i) => i.severity === 'error' && !i.nodeId);
  const visible = useMemo(
    () =>
      globalFields.filter((f) =>
        search.trim()
          ? (f.label + ' ' + f.scope + ' ' + f.help + ' ' + f.key)
              .toLowerCase()
              .includes(search.trim().toLowerCase())
          : f.section === section,
      ),
    [search, section],
  );
  const [visited, setVisited] = useState<string[]>([]);
  const visibleKeys = useMemo(() => visible.map((f) => f.key), [visible]);
  useEffect(() => {
    setVisited((current) =>
      visibleKeys.every((key) => current.includes(key))
        ? current
        : [...new Set([...current, ...visibleKeys])],
    );
  }, [visibleKeys]);
  const focusIssue = useLocalDiagnosticFocus(dialog);
  const reviewLocal = (issue: Diagnostic) => {
    setSearch('');
    setSection(
      globalFields.find((f) => f.key === issue.fieldKey)?.section ??
        (issue.fieldKey === 'resources' ? 'resources' : 'core'),
    );
    focusIssue(issue);
  };
  const set = (key: string, value: SettingValue) =>
    setDraft((current) =>
      value === ''
        ? resetCoreDefault(current, key)
        : { ...current, settings: { ...current.settings, [key]: value } },
    );
  const renderFields = (fields: typeof globalFields) => (
    <div className="field-grid defaults-field-grid">
      {fields.map((f) => (
        <div
          className={
            'default-option' +
            (f.type === 'json' || f.type === 'textarea' || f.key === 'userAgent'
              ? ' wide-option'
              : '')
          }
          key={f.key}
          hidden={!visibleKeys.includes(f.key)}
        >
          <div className="default-scope">
            <span
              className={
                Object.hasOwn(draft.settings, f.key) ? 'override-badge' : 'inherited-badge'
              }
            >
              {Object.hasOwn(draft.settings, f.key)
                ? draft.settings[f.key] === ''
                  ? 'App setting · blank'
                  : 'App setting'
                : 'Xray default'}
            </span>
            <button
              type="button"
              className="secondary-button button--small"
              disabled={!Object.hasOwn(draft.settings, f.key)}
              aria-label={'Use Xray default for ' + f.label}
              onClick={() => {
                setDraft((d) => resetCoreDefault(d, f.key));
                resetPolicyDraft(f.key);
              }}
            >
              Use Xray default
            </button>
            <button
              type="button"
              className="secondary-button button--small"
              title={'Restore factory value for ' + f.label}
              aria-label={'Restore factory ' + f.label}
              disabled={draft.settings[f.key] === f.defaultValue}
              onClick={() => {
                setDraft((d) => ({
                  ...d,
                  settings: { ...d.settings, [f.key]: f.defaultValue! },
                }));
                resetPolicyDraft(f.key);
              }}
            >
              <Undo2 size={11} /> Factory
            </button>
          </div>
          <SettingField
            hint={coreDefaultHint(coreDefaultField(f.key))}
            effectiveText={
              draft.settings[f.key] === 0 && configuredDefaultHint(f.key, 0) !== '0'
                ? configuredDefaultHint(f.key, 0)
                : undefined
            }
            inherited={!Object.hasOwn(draft.settings, f.key)}
            onValidity={policyValidity}
            onInherit={() => {
              setDraft((d) => resetCoreDefault(d, f.key));
              resetPolicyDraft(f.key);
            }}
            field={{ ...f, key: 'global-' + f.key }}
            value={draft.settings[f.key]}
            issues={issues.filter((i) => i.fieldKey === f.key && !i.controlId)}
            messagePrefix="Global defaults: "
            onChange={(value) => {
              set(f.key, value);
              resetPolicyDraft(f.key);
            }}
          />
          {f.key === 'policy' && policy && (
            <PolicyFields
              key={policyRevision}
              policy={policy}
              idPrefix="global-policy"
              onValidity={policyValidity}
              onChange={(value) => set('policy', JSON.stringify(value, null, 2))}
            />
          )}
        </div>
      ))}
    </div>
  );
  useModalDialog(dialog);
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window defaults-window"
      aria-labelledby="defaults-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="defaults-title">
            <Settings2 size={18} /> Global defaults
          </h2>
          <p>Defaults for this graph · unset fields use Xray {embeddedCoreDefaults.version}.</p>
        </div>
        <button className="icon-button" aria-label="Close global defaults" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="action-row defaults-search">
        <label className="search-control">
          <Search size={15} aria-hidden="true" />
          <input
            autoComplete="off"
            aria-label="Search global defaults"
            placeholder="Search settings, transport or scope…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <span>{globalFields.length} settings</span>
      </div>
      <div className="defaults-columns">
        <nav className="defaults-navigation" aria-label="Default categories">
          {[...defaultSections, { id: 'display', title: 'Traffic display', description: '' }].map(
            (s) => (
              <button
                key={s.id}
                aria-pressed={!search && section === s.id}
                onClick={() => {
                  setSection(s.id);
                  setSearch('');
                }}
              >
                <span>{s.title}</span>
                {!['resources', 'display'].includes(s.id) && (
                  <small>{globalFields.filter((f) => f.section === s.id).length}</small>
                )}
              </button>
            ),
          )}
        </nav>
        <div className="defaults-content">
          {!search && section !== 'resources' && (
            <div className="defaults-category-heading">
              <h3>
                {section === 'display'
                  ? 'Traffic display'
                  : defaultSections.find((s) => s.id === section)?.title}
              </h3>
              {section !== 'display' && (
                <p>{defaultSections.find((s) => s.id === section)?.description}</p>
              )}
            </div>
          )}
          {(search
            ? 'resources geoip geosite files sources updates'.includes(search.trim().toLowerCase())
            : section === 'resources') && (
            <ResourceFields
              value={draft.resources ?? factoryResources()}
              onChange={(resources) => setDraft((d) => ({ ...d, resources }))}
            />
          )}
          {(search
            ? 'traffic display rate amount units'.includes(search.trim().toLowerCase())
            : section === 'display') && (
            <>
              <TrafficUnitSettings />
              <p className="field-help">App preference · applies immediately to all graphs.</p>
            </>
          )}
          {defaultSections.map((category) => {
            const retained = globalFields.filter(
                (f) =>
                  f.section === category.id &&
                  (visibleKeys.includes(f.key) || visited.includes(f.key)),
              ),
              basic = retained.filter(
                (f) => category.id === 'advanced' || basicGlobalSettings.has(f.key),
              ),
              advanced = retained.filter(
                (f) => category.id !== 'advanced' && !basicGlobalSettings.has(f.key),
              );
            if (!retained.length) return null;
            const active = retained.some((f) => visibleKeys.includes(f.key));
            return (
              <section key={category.id} hidden={!active} className="defaults-settings-group">
                {!!search && <h3>{category.title}</h3>}
                {!!basic.length && renderFields(basic)}
                {!!advanced.length && (
                  <AdvancedSettings
                    configured={advanced
                      .filter(
                        (f) => visibleKeys.includes(f.key) && Object.hasOwn(draft.settings, f.key),
                      )
                      .map((f) => f.label)}
                    reveal={!!search.trim() && advanced.some((f) => visibleKeys.includes(f.key))}
                  >
                    {renderFields(advanced)}
                  </AdvancedSettings>
                )}
              </section>
            );
          })}
          {!visible.length && !['resources', 'display'].includes(section) && (
            <p className="empty-state">No matching defaults.</p>
          )}
          {large && analysis.pending && <p role="status">Checking affected nodes…</p>}
          {checkFailure && <p role="alert">{checkFailure.message}</p>}
          {!!inheritedErrors.length && (
            <div className="notice notice--warning defaults-impact-warning" role="status">
              <strong>
                {inheritedErrors.length} node configuration issue(s) after these defaults
              </strong>
              <p>
                Review the affected nodes before compiling. Saving defaults keeps unfinished node
                drafts.
              </p>
              {inheritedErrors.slice(0, 3).map((i, index) => (
                <p key={index}>{i.message}</p>
              ))}
            </div>
          )}
        </div>
      </div>
      {!!errors.length && (
        <div className="rule-editor-diagnostics" role="alert">
          <DiagnosticList issues={errors} onIssue={reviewLocal} local />
        </div>
      )}
      {saveError && (
        <p className="notice notice--error" role="alert">
          {saveError}
        </p>
      )}
      <div className="rule-editor-footer">
        <span>
          {changed ? changed + ' changed · ' + affected + ' node(s) affected' : 'No changes'}
          {overridden > 0 && ` · ${overridden} independent settings retained`}
        </span>
        <button
          className="secondary-button"
          onClick={() => {
            setDraft(resetCoreDefault(draft));
            resetPolicyDraft();
          }}
        >
          Use all Xray defaults
        </button>
        <button
          className="secondary-button"
          onClick={() => {
            setDraft(factoryDefaults());
            resetPolicyDraft();
          }}
        >
          Factory defaults
        </button>
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={!!errors.length || Object.values(invalidPolicy).some(Boolean) || !changed}
          onClick={() => save(() => onApply(draft))}
        >
          Save defaults
        </button>
      </div>
    </dialog>
  );
}

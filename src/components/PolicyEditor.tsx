import AdvancedSettings from './AdvancedSettings';
import PolicyGroupBasics from '@wayrill/ui/PolicyGroupBasics';
import { testUrlSuggestions } from '../testUrlSuggestions';
import { clearNodePosition } from '../graph/placement';
import { policyDiagnosticTab } from '../graph/editorNavigation';
import DiagnosticList, {
  useRequestedDiagnostic,
  useLocalDiagnosticFocus,
  draftNumberIssues,
} from './DiagnosticNavigation';
import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import useModalDialog from './useModalDialog';
import usePolicyPreview from '../profiles/usePolicyPreview';
import { compileXrayGraph } from '../graph/xrayCompiler';
import { policyContextPreview } from '../graph/configPreview';
import { X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { makeNode } from '../graph/catalog';
import { isExecutableOutboundKind, outboundBundle } from '../graph/outbounds';
import { fieldProblem } from '../graph/settingValidation';
import {
  editPolicyGraph,
  policyDefinitions,
  policyNeedsObservation,
  policyProblems,
} from '../graph/policies';
import { compilePolicies } from '../graph/policyCompilation';
import { observationSnapshot } from '../graph/composites';
import type { Diagnostic, GraphState, RuleNode, RuleNodeData, SettingValue } from '../graph/types';
import {
  cachePolicyPreview,
  readPolicySources,
  emptyPolicySources,
  blockPolicyFallback,
  type PolicySources,
} from '../graph/policySources';
import type { Stash } from '../profiles/import';
import { generatedTag, ensureNodeTags } from '../graph/tags';
import TagReferencePicker from './TagReferencePicker';
import PolicySourcesEditor from './PolicySourcesEditor';
import { referenceSummary } from './editorSummaries';
import PolicyOutboundPicker from './PolicyOutboundPicker';
import { SettingField } from './SettingField';
import { settingDefaultHint } from '../graph/defaults';

export default function PolicyEditor({
  node: sourceNode,
  graph: sourceGraph,
  stash,
  onApply,
  onClose,
  applyLabel = 'Apply changes',
}: {
  node: RuleNode;
  graph: GraphState;
  stash: Stash;
  onApply: (graph: GraphState) => void | Promise<void>;
  applyLabel?: string;
  onClose: () => void;
}) {
  const graph = useMemo(() => ensureNodeTags(sourceGraph), [sourceGraph]);
  const node = graph.nodes.find((node) => node.id === sourceNode.id) ?? sourceNode;
  const requested = useRequestedDiagnostic();
  const [name, setName] = useState(node.data.label),
    [saveError, setSaveError] = useState(''),
    [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    isGroup = node.data.kind === 'policy-group';
  const needsTag = isGroup && !node.data.native && !node.data.settings.tag;
  const connected = graph.edges.find(
    (e) => e.source === node.id && e.sourceHandle === 'observation',
  );
  const existing =
    graph.nodes.find((n) => n.id === connected?.target && n.data.kind === 'observatory') ??
    graph.nodes.find((n) => n.data.kind === 'observatory');
  const [settings, setSettings] = useState<RuleNodeData['settings']>(() => ({
    ...node.data.settings,
    ...(needsTag ? { tag: generatedTag('pg', node.data.label.trim(), node.id) } : {}),
    ...(isGroup && graph.edges.some((e) => e.source === node.id && e.sourceHandle === 'observation')
      ? { observe: true }
      : {}),
  }));
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>({});
  const validity = useCallback(
    (id: string, valid: boolean) =>
      setInvalidFields((current) =>
        current[id] === !valid ? current : { ...current, [id]: !valid },
      ),
    [],
  );
  const [observer, setObserver] = useState<RuleNode>(() => {
    if (!isGroup) return node;
    if (existing) return existing;
    const result = makeNode(
      'observatory',
      clearNodePosition(graph.nodes, { x: node.position.x, y: node.position.y + 320 }),
    );
    const saved = observationSnapshot(node.data);
    if (saved) result.data.settings = saved;
    return result;
  });
  const [tab, setTab] = useState<'candidates' | 'observation' | 'preview'>(
    policyDiagnosticTab(node.data, requested),
  );
  const [sources, setSources] = useState<PolicySources>(() =>
    isGroup ? readPolicySources(node.data) : emptyPolicySources(),
  );
  const corePreview = tab === 'preview';
  const previewInput = useMemo(
    () => ({ settings, sources, observer, corePreview }),
    [settings, sources, observer, corePreview],
  );
  const preparation = usePolicyPreview(graph, node, stash, previewInput, isGroup);
  const resolvedSources = sources;
  const data: RuleNodeData = useMemo(
    () => ({
      ...node.data,
      label: name.trim(),
      settings: {
        ...settings,
        ...(isGroup ? { sources: node.data.settings.sources } : {}),
      },
    }),
    [node.data, name, settings, isGroup],
  );
  const candidateCount = preparation.result?.summary.total ?? 0;
  const pool = preparation.pending
    ? 'Updating candidate set…'
    : preparation.error
      ? 'Candidate set unavailable'
      : `${candidateCount.toLocaleString()} ${candidateCount === 1 ? 'candidate' : 'candidates'}`;
  const observed = isGroup && (preparation.result?.observed ?? policyNeedsObservation(data));
  const observerData = isGroup ? observer.data : data;
  const observerNeeded = observed || !isGroup;
  const definitions = policyDefinitions.find((d) => d.kind === node.data.kind)!;
  const check = (d: RuleNodeData) => [
    ...policyProblems(d),
    ...policyDefinitions
      .find((n) => n.kind === d.kind)!
      .fields.flatMap((f) => {
        const message = fieldProblem(f, d.settings);
        return message
          ? [{ severity: 'error' as const, fieldKey: f.key, message: `${f.label}: ${message}` }]
          : [];
      }),
  ];
  const issues: Diagnostic[] = [
    ...(isGroup ? (preparation.result?.issues ?? []) : check(data)),
    ...(preparation.error && !preparation.pending
      ? [{ severity: 'error' as const, fieldKey: 'sources', message: preparation.error }]
      : []),
    ...(isGroup && observerNeeded
      ? check(observerData).map((issue) => ({ ...issue, nodeId: observer.id }))
      : []),
    ...draftNumberIssues(invalidFields, [
      ...definitions.fields,
      ...policyDefinitions.find((d) => d.kind === 'observatory')!.fields,
    ]),
  ];
  const errors = issues.filter((i) => i.severity === 'error');
  const initialSources = useRef(sources);
  const untouchedEmpty =
    sources === initialSources.current &&
    !sources.manual.length &&
    !sources.subscriptions.length &&
    settings.selection !== 'prefixes';
  const visibleIssues = issues.filter(
    (issue) =>
      !(
        untouchedEmpty &&
        issue.fieldKey === 'sources' &&
        /no (?:outbound matches|candidate destinations match)/i.test(issue.message)
      ),
  );
  const observerUsedBy = graph.edges.filter(
    (e) => e.target === observer.id && e.sourceHandle === 'observation' && e.source !== node.id,
  ).length;
  const set = (key: string, value: SettingValue) => setSettings((s) => ({ ...s, [key]: value }));
  const setObserverSetting = (key: string, value: SettingValue) =>
    isGroup
      ? setObserver((n) => ({
          ...n,
          data: { ...n.data, settings: { ...n.data.settings, [key]: value } },
        }))
      : set(key, value);
  const field = (key: string, observation = false) => {
    const d = observation ? observerData : data,
      f = (
        observation ? policyDefinitions.find((n) => n.kind === 'observatory')! : definitions
      ).fields.find((n) => n.key === key)!;
    if (key === 'selectorPrefixes')
      return (
        <div className="editor-field" key={key}>
          <label htmlFor={`policy-${node.id}-${observation}-destinations`}>
            {observation || !isGroup ? 'Observed outbounds' : 'Candidate outbounds'}
          </label>
          <TagReferencePicker
            id={`policy-${node.id}-${observation}-destinations`}
            label={observation || !isGroup ? 'Observed outbounds' : 'Candidate outbounds'}
            kind="outbound"
            graph={graph}
            multiple
            prefixes
            value={String(d.settings[key] ?? '')}
            onChange={(value) => (observation ? setObserverSetting(key, value) : set(key, value))}
          />
        </div>
      );
    return (
      <SettingField
        key={key}
        hint={settingDefaultHint(d, f, graph.defaults)}
        idPrefix={`policy-${node.id}-${observation ? 'observer' : 'group'}`}
        field={f}
        suggestions={
          observation && ['probeURL', 'destination', 'connectivity'].includes(key)
            ? testUrlSuggestions
            : undefined
        }
        onValidity={validity}
        value={d.settings[key]}
        issues={issues.filter(
          (i) =>
            i.fieldKey === key &&
            !i.controlId &&
            (observation ? i.nodeId === observer.id || !isGroup : !i.nodeId),
        )}
        onChange={(value) => (observation ? setObserverSetting(key, value) : set(key, value))}
      />
    );
  };
  const nextGraph = (sourceText?: string) => {
    const next = editPolicyGraph(
      graph,
      node.id,
      sourceText === undefined ? data.settings : { ...data.settings, sources: sourceText },
      observed ? observer.id : undefined,
      isGroup && observed ? observer : undefined,
    );
    return {
      ...next,
      nodes: next.nodes.map((n) =>
        n.id === node.id
          ? {
              ...n,
              data: {
                ...n.data,
                label: name.trim(),
                settings: {
                  ...n.data.settings,
                  ...(observed
                    ? { observationSettings: JSON.stringify(observer.data.settings) }
                    : {}),
                },
              },
            }
          : n,
      ),
    };
  };
  let preview = preparation.pending
    ? 'Preparing the current draft…'
    : (preparation.result?.corePreview ?? '');
  if (!isGroup && tab === 'preview') {
    try {
      preview = JSON.stringify(
        policyContextPreview(
          graph.xray
            ? compileXrayGraph(nextGraph()).config
            : (compilePolicies(nextGraph(), [
                { tag: 'wr-u' },
                ...graph.nodes
                  .filter((n) => isExecutableOutboundKind(n.data.kind))
                  .flatMap((n) => outboundBundle(n.data)),
              ]) as unknown as Record<string, unknown>),
        ),
        null,
        2,
      );
    } catch (error) {
      preview = error instanceof Error ? error.message : String(error);
    }
  }
  const focusIssue = useLocalDiagnosticFocus(dialog);
  const reviewLocal = (issue: import('../graph/types').Diagnostic) => {
    setTab(
      issue.nodeId === observer.id || issue.controlId?.includes('-observer-')
        ? 'observation'
        : policyDiagnosticTab(node.data, issue),
    );
    focusIssue(issue);
  };
  useModalDialog(dialog);
  const tabs = useEditorTabs(
    (isGroup
      ? (['candidates', 'observation', 'preview'] as const)
      : (['observation', 'preview'] as const)
    ).map((key) => ({
      key,
      label: {
        candidates: 'Members',
        observation: isGroup ? 'Health checks' : 'Observatory',
        preview: 'Core preview',
      }[key],
    })),
    tab,
    setTab,
  );
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window policy-editor dialog--compact"
      aria-labelledby="policy-editor-title"
      onCancel={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onClose={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="policy-editor-title">
            {isGroup ? 'Edit Group' : 'Observatory'} · {node.data.label}
          </h2>
          {!isGroup && <p>Shared observatory · probes travel through the observed outbounds.</p>}
        </div>
        <button className="icon-button" aria-label="Close policy editor" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {isGroup && (
        <PolicyGroupBasics
          name={name}
          strategy={String(settings.strategy)}
          disabled={saving}
          onNameChange={(value) => {
            setName(value);
          }}
          onStrategyChange={(mode) => set('strategy', mode)}
        />
      )}
      <EditorTabs tabs={tabs} label="Policy editor sections" disabled={saving} />
      {isGroup && (
        <section
          className="policy-draft-summary"
          aria-label="Draft policy summary"
          aria-busy={preparation.pending}
        >
          <strong>{pool}</strong>
          <span>
            Fallback:{' '}
            {settings.fallbackEnabled
              ? resolvedSources.fallback
                ? referenceSummary(graph, resolvedSources.fallback).name
                : 'Not selected'
              : 'None'}
          </span>
        </section>
      )}
      <EditorTabPanels tabs={tabs} className="rule-editor-body policy-editor-body" inert={saving}>
        {(tab) => (
          <>
            {tab === 'candidates' && (
              <>
                <PolicySourcesEditor
                  graph={graph}
                  node={{ ...node, data }}
                  stash={stash}
                  sources={sources}
                  previewResult={preparation.result?.summary}
                  previewSubscriptions={preparation.result?.subscriptions}
                  previewQuery={preparation.query}
                  onPreviewQuery={preparation.setQuery}
                  pending={preparation.pending}
                  problem={preparation.error}
                  pristineEmpty={untouchedEmpty}
                  controls={
                    <>
                      <section
                        className="policy-fallback"
                        aria-label="Fallback selection"
                        data-setting-key="fallbackEnabled"
                        data-diagnostic-field="fallback"
                      >
                        <PolicyOutboundPicker
                          single
                          label="Fallback"
                          fieldLabel="Fallback"
                          excludeId={node.id}
                          graph={graph}
                          stash={stash}
                          selected={settings.fallbackEnabled ? resolvedSources.fallback : undefined}
                          presets={[
                            { id: 'block', label: 'Block', reference: blockPolicyFallback() },
                            { id: 'none', label: 'No fallback' },
                          ]}
                          onClear={() => set('fallbackEnabled', false)}
                          onSelect={(fallback) => {
                            set('fallbackEnabled', true);
                            setSources((current) => ({ ...current, fallback }));
                          }}
                        />
                        <p className="field-help">
                          Used when no member is available. Block stops the connection.
                        </p>
                      </section>
                      {field('selection')}
                      {settings.selection === 'prefixes' && field('selectorPrefixes')}
                    </>
                  }
                  onChange={(next) => {
                    setSources(next);
                    preparation.setQuery((q) => ({ ...q, page: 0 }));
                  }}
                />
                {settings.strategy === 'leastLoad' && (
                  <AdvancedSettings
                    title="Selection tuning"
                    configured={['expected', 'maxRTT', 'baselines', 'costs', 'tolerance'].filter(
                      (key) => settings[key] !== definitions.defaults[key],
                    )}
                  >
                    <div className="editor-two-fields">
                      {field('expected')}
                      {field('maxRTT')}
                    </div>
                    {field('baselines')}
                    <p className="field-help">
                      With baselines and expected count zero, Xray uses the fallback when no
                      candidate meets a baseline.
                    </p>
                    {field('tolerance')}
                    {field('costs')}
                  </AdvancedSettings>
                )}
                <AdvancedSettings
                  title="Native options"
                  configured={['strategyExtra', 'extra'].filter(
                    (key) => settings[key] && settings[key] !== '{}',
                  )}
                >
                  {field('strategyExtra')}
                  {field('extra')}
                </AdvancedSettings>
              </>
            )}
            {tab === 'observation' && (
              <>
                {isGroup &&
                  !settings.fallbackEnabled &&
                  ['random', 'roundRobin'].includes(String(settings.strategy)) &&
                  field('observe')}
                {isGroup && !observed ? (
                  <div className="notice">
                    Enable “Observe candidate health” to configure availability checks.
                  </div>
                ) : (
                  <>
                    <p className="notice">
                      {isGroup
                        ? `${existing ? 'Uses' : 'Creates'} the shared observatory. Applying also changes its settings${observerUsedBy ? ` for ${observerUsedBy} other connected group(s)` : ''}.`
                        : `Shared by ${observerUsedBy} connected group(s).`}
                    </p>
                    {field('mode', true)}
                    {field('subjects', true)}
                    {observerData.settings.subjects === 'prefixes' &&
                      field('selectorPrefixes', true)}
                    <p className="field-help">
                      Automatic subjects include connected outbounds and policy candidates. Native
                      prefixes must cover every candidate used by those groups.
                    </p>
                    {observerData.settings.mode === 'standard' ? (
                      <>
                        {field('probeURL', true)}
                        {field('probeInterval', true)}
                      </>
                    ) : (
                      <>
                        {field('destination', true)}
                        {field('connectivity', true)}
                        {field('interval', true)}
                      </>
                    )}
                    {settings.strategy === 'leastLoad' &&
                      observerData.settings.mode === 'standard' && (
                        <p className="warning">
                          Standard probes supply latency. Choose burst sampling to use failure
                          ratios and sampled latency deviation.
                        </p>
                      )}
                    <AdvancedSettings
                      configured={[
                        ...(observerData.settings.mode === 'standard'
                          ? observerData.settings.enableConcurrency
                            ? ['Concurrent probes']
                            : []
                          : ['sampling', 'timeout', 'httpMethod'].filter(
                              (key) =>
                                observerData.settings[key] !==
                                policyDefinitions.find((d) => d.kind === 'observatory')!.defaults[
                                  key
                                ],
                            )),
                        ...[
                          ...(observerData.settings.mode === 'burst' ? ['healthExtra'] : []),
                          'extra',
                        ].filter(
                          (key) =>
                            observerData.settings[key] && observerData.settings[key] !== '{}',
                        ),
                      ]}
                    >
                      {observerData.settings.mode === 'standard' ? (
                        field('enableConcurrency', true)
                      ) : (
                        <>
                          <div className="editor-two-fields">
                            {field('sampling', true)}
                            {field('timeout', true)}
                          </div>
                          {field('httpMethod', true)}
                        </>
                      )}
                      {observerData.settings.mode === 'burst' && field('healthExtra', true)}
                      {field('extra', true)}
                    </AdvancedSettings>
                  </>
                )}
              </>
            )}
            {tab === 'preview' && (
              <>
                <p className="field-help">
                  Balancer and observatory fragments. May contain credentials.
                </p>
                <pre className="code-block" tabIndex={0}>
                  {preview}
                </pre>
              </>
            )}
          </>
        )}
      </EditorTabPanels>
      <div className="rule-editor-diagnostics" aria-live="polite">
        {saveError && (
          <div className="notice notice--error" role="alert">
            {saveError}
          </div>
        )}
        <DiagnosticList issues={visibleIssues} onIssue={reviewLocal} local />
      </div>
      <div className="rule-editor-footer">
        {(preparation.pending || errors.length > 0) && (
          <span>
            {preparation.pending
              ? 'Checking draft…'
              : untouchedEmpty
                ? 'Choose candidates to continue'
                : `${errors.length} issue(s) to correct`}
          </span>
        )}
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={
            saving ||
            preparation.pending ||
            errors.length > 0 ||
            !name.trim() ||
            Object.values(invalidFields).some(Boolean)
          }
          onClick={() =>
            void (async () => {
              setSaveError('');
              setSaving(true);
              try {
                const snapshot = isGroup ? await preparation.snapshot() : undefined;
                const next = nextGraph(snapshot?.serialized);
                if (snapshot)
                  cachePolicyPreview(
                    next.nodes.find((n) => n.id === node.id)!.data,
                    snapshot.sources,
                    snapshot.serialized,
                    stash,
                  );
                const result = onApply(next);
                if (result) await result;
                onClose();
              } catch (e) {
                setSaveError(e instanceof Error ? e.message : String(e));
              } finally {
                setSaving(false);
              }
            })()
          }
        >
          {saving ? 'Saving…' : applyLabel}
        </button>
      </div>
    </dialog>
  );
}

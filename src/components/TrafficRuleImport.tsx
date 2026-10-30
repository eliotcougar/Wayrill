import { useEffect, useRef, useState } from 'react';
import RuleSourceLoader, { type SourceLocation } from './RuleSourceLoader';
import {
  attachTrafficSource,
  detachTrafficSource,
  refreshTrafficSource,
} from '../graph/trafficRuleSource';
import {
  parseTrafficRules,
  importTrafficRules,
  trafficImportBase,
  rolesForTrafficImport,
  type ImportedTrafficRules,
} from '../graph/trafficRuleImport';
import { newPresetOutput, type PresetBindings, type PresetMode } from '../graph/routingPresets';
import type { RuleTable } from '../graph/rules';
import type { GraphState, RuleNode } from '../graph/types';
import { isXrayOutbound } from '../graph/xrayNodes';
import { ruleConditionSummary } from './editorSummaries';

export default function TrafficRuleImport({
  table,
  graph,
  node,
  onImport,
}: {
  table: RuleTable;
  graph: GraphState;
  node: RuleNode;
  onImport: (table: RuleTable, strategy: string | null) => void;
}) {
  const reviewTitle = useRef<HTMLHeadingElement>(null),
    alert = useRef<HTMLParagraphElement>(null);
  const [location, setLocation] = useState<SourceLocation | null>(null),
    [refresh, setRefresh] = useState(false),
    [keepSource, setKeepSource] = useState(true);
  const [source, setSource] = useState<ImportedTrafficRules | null>(null),
    [sourceName, setSourceName] = useState('');
  const [problem, setProblem] = useState('');
  const [bindings, setBindings] = useState<PresetBindings>({}),
    [mode, setMode] = useState<PresetMode>('replace'),
    [setStrategy, setSetStrategy] = useState(true);
  useEffect(() => {
    if (problem) alert.current?.focus();
    else if (source) reviewTitle.current?.focus();
  }, [problem, source]);
  function reset() {
    setSource(null);
    setBindings({});
    setProblem('');
  }
  const destination = (id: string) =>
    graph.nodes.find(
      (n) =>
        n.id === graph.edges.find((e) => e.source === node.id && e.sourceHandle === id)?.target,
    );
  const guess = (role: NonNullable<typeof source>['roles'][number]) =>
    table.outputs.find((o) => {
      const target = destination(o.id);
      return (
        o.name.toLowerCase() === role.tag.toLowerCase() ||
        target?.data.settings.tag === role.tag ||
        (role.kind === 'outbound' &&
          (role.tag === 'direct'
            ? target?.data.kind === 'direct-outbound'
            : role.tag === 'block'
              ? target?.data.kind === 'block-outbound'
              : role.tag === 'proxy' &&
                !!target &&
                (isXrayOutbound(target) || target.data.kind === 'policy-group') &&
                !['direct-outbound', 'block-outbound'].includes(target.data.kind)))
      );
    })?.id ?? newPresetOutput;
  const roles = source ? rolesForTrafficImport(source, refresh ? 'append' : mode) : [];
  const resolved = Object.fromEntries(
    roles.map((r) => {
      const saved = refresh ? table.source?.bindings[r.id] : undefined;
      return [
        r.id,
        bindings[r.id] ?? (table.outputs.some((o) => o.id === saved) ? saved! : guess(r)),
      ];
    }),
  );
  return (
    <div className="routing-presets traffic-rule-import">
      <RuleSourceLoader
        source={table.source}
        missing={table.rules.some((rule) => rule.source?.missing)}
        onReset={reset}
        onDetach={() => onImport(detachTrafficSource(table), null)}
        onLoad={(text, name, location, refresh) => {
          const parsed = parseTrafficRules(text);
          setSource(parsed);
          setSourceName(name);
          setLocation(location);
          setRefresh(refresh);
          setBindings({});
          setProblem('');
        }}
      />
      {problem && (
        <p ref={alert} tabIndex={-1} role="alert" className="field-message error">
          {problem}
        </p>
      )}
      {source && (
        <>
          <h3 ref={reviewTitle} tabIndex={-1}>
            {sourceName} · {source.sourceRules} source rules
          </h3>
          {!refresh && (
            <label className="editor-field">
              <span>Import mode</span>
              <select
                aria-label="Routing import mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as PresetMode)}
              >
                <option value="replace">Replace rules</option>
                <option value="append">Append rules · keep current default</option>
              </select>
            </label>
          )}
          {!refresh && (
            <label className="check-control">
              <input
                type="checkbox"
                checked={keepSource && !(source.source && mode === 'append')}
                disabled={!!source.source && mode === 'append'}
                onChange={(e) => setKeepSource(e.target.checked)}
              />{' '}
              {source.source ? 'Keep source and overrides' : 'Keep source for manual updates'}
            </label>
          )}
          <button
            className="primary-button preset-import-button"
            onClick={() => {
              try {
                const base = trafficImportBase(
                  table,
                  source,
                  resolved,
                  refresh ? 'append' : mode,
                  graph.edges.some((e) => e.source === node.id),
                );
                onImport(
                  refresh
                    ? refreshTrafficSource(table, source, resolved)
                    : source.source
                      ? importTrafficRules(base, source, resolved, mode, keepSource)
                      : keepSource && location
                        ? attachTrafficSource(base, source, resolved, mode, location)
                        : importTrafficRules(base, source, resolved, mode),
                  !refresh && mode === 'replace' && setStrategy
                    ? (source.domainStrategy ?? null)
                    : null,
                );
                setProblem('');
              } catch (error) {
                setProblem(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            {refresh ? 'Update rules' : 'Import rules'}
          </button>
          <div className="preset-output-mapping">
            {roles.map((role) => (
              <label key={role.id} className="editor-field">
                <span>
                  {role.name}
                  {role.kind === 'balancer' ? ' (policy group)' : ''}
                </span>
                <select
                  aria-label={`${role.kind === 'balancer' ? 'Imported policy output' : 'Imported output'}: ${role.tag}`}
                  value={resolved[role.id]}
                  onChange={(e) => setBindings((b) => ({ ...b, [role.id]: e.target.value }))}
                >
                  <option value={newPresetOutput}>New output · {role.name}</option>
                  {table.outputs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name || 'Unnamed output'} →{' '}
                      {destination(o.id)?.data.label ?? 'Not connected'}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {source.domainStrategy && !refresh && mode === 'replace' && (
            <label className="check-control">
              <input
                type="checkbox"
                checked={setStrategy}
                onChange={(e) => setSetStrategy(e.target.checked)}
              />{' '}
              Set graph routing domain strategy to {source.domainStrategy}
            </label>
          )}
          <div className="preset-preview" aria-label="Imported rule preview">
            <ol>
              {source.rules.map((r, i) => (
                <li key={i}>
                  <strong>
                    {r.name}
                    {r.enabled ? '' : ' (disabled)'}
                  </strong>
                  <span>
                    {source.roles.find((o) => o.id === r.output)?.name} ·{' '}
                    {ruleConditionSummary({ ...r, id: `preview-${i}` })}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <p className="field-help">
            Unmatched traffic →{' '}
            {!refresh && mode === 'replace' && source.defaultOutput
              ? source.roles.find((r) => r.id === source.defaultOutput)?.name
              : table.outputs.find((o) => o.id === table.defaultOutput)?.name}
          </p>
          {source.notes
            .filter((n) => (!refresh && mode === 'replace') || !n.startsWith('Final catch-all'))
            .map((note) => (
              <p className="field-help" key={note}>
                {note}
              </p>
            ))}
          <p className="field-help">
            Connect new outputs before running. Apply changes commits this draft.
          </p>
        </>
      )}
    </div>
  );
}

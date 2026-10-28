import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { readImportText } from '../importText';
import { Upload, Download } from 'lucide-react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  attachTrafficSource,
  detachTrafficSource,
  refreshTrafficSource,
} from '../graph/trafficRuleSource';
import type { TrafficSource } from '../graph/ruleSourceModel';
import { LIMITS, CONFIG_LIMIT_LABEL } from '../limits';
import { downloadRoutingRules } from '../routingDownload';
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
import useFileRead from './useFileRead';
type SourceLocation = Omit<TrafficSource, 'version' | 'bindings' | 'updatedAt'>;

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
  const file = useRef<HTMLInputElement>(null),
    request = useRef<AbortController | null>(null),
    reviewTitle = useRef<HTMLHeadingElement>(null),
    alert = useRef<HTMLParagraphElement>(null);
  const reads = useFileRead();
  const refreshFile = useRef(false);
  const [url, setUrl] = useState(table.source?.kind === 'url' ? table.source.location : ''),
    [allowHttp, setAllowHttp] = useState(table.source?.allowHttp ?? false),
    [viaWayrill, setViaWayrill] = useState(table.source?.viaWayrill ?? false);
  const [location, setLocation] = useState<Omit<
      TrafficSource,
      'version' | 'bindings' | 'updatedAt'
    > | null>(null),
    [refresh, setRefresh] = useState(false),
    [keepSource, setKeepSource] = useState(true);
  const [source, setSource] = useState<ImportedTrafficRules | null>(null),
    [sourceName, setSourceName] = useState('');
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState('');
  const [bindings, setBindings] = useState<PresetBindings>({}),
    [mode, setMode] = useState<PresetMode>('replace'),
    [setStrategy, setSetStrategy] = useState(true);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (problem) alert.current?.focus();
    else if (source) reviewTitle.current?.focus();
  }, [problem, source]);
  function reset() {
    reads.cancel();
    request.current?.abort();
    setBusy(false);
    setProblem('');
    setSource(null);
    setBindings({});
  }
  function accept(text: string, name: string, location: SourceLocation, refresh = false) {
    setSource(parseTrafficRules(text));
    setSourceName(name);
    setLocation(location);
    setRefresh(refresh);
    setBindings({});
    setProblem('');
  }
  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    const updating = refreshFile.current;
    refreshFile.current = false;
    reset();
    const current = reads.begin();
    setBusy(true);
    try {
      if (selected.size > LIMITS.configBytes)
        throw new Error(`Routing files must be at most ${CONFIG_LIMIT_LABEL}.`);
      const text = await readImportText(selected);
      if (current())
        accept(
          text,
          selected.name,
          { kind: 'file', location: selected.name, allowHttp: false, viaWayrill: false },
          updating,
        );
    } catch (error) {
      if (current())
        setProblem(error instanceof Error ? error.message : 'Could not read this file.');
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function loadNativeFile(path?: string) {
    reset();
    const current = reads.begin();
    setBusy(true);
    try {
      const selected = await invoke<{ path: string; text: string } | null>('routing_source_file', {
        path: path ?? null,
      });
      if (current() && selected)
        accept(
          selected.text,
          selected.path,
          { kind: 'file', location: selected.path, allowHttp: false, viaWayrill: false },
          path !== undefined,
        );
    } catch (error) {
      if (current()) setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function loadUrl(saved?: TrafficSource) {
    reset();
    const current = reads.begin(),
      controller = new AbortController();
    request.current = controller;
    setBusy(true);
    const timeout = setTimeout(
      () => controller.abort(new Error('Routing download timed out.')),
      60000,
    );
    try {
      const location = saved ?? {
        kind: 'url' as const,
        location: url.trim(),
        allowHttp,
        viaWayrill,
      };
      const text = await downloadRoutingRules(
        location.location,
        location.allowHttp,
        location.viaWayrill,
        controller.signal,
      );
      if (current()) accept(text, 'Downloaded routing rules', location, !!saved);
    } catch (error) {
      if (current())
        setProblem(
          controller.signal.aborted
            ? 'Routing download timed out.'
            : error instanceof Error
              ? error.message
              : String(error),
        );
    } finally {
      clearTimeout(timeout);
      if (current()) setBusy(false);
    }
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
      {table.source && (
        <section className="traffic-source-summary" aria-label="Current rule source">
          <strong>{table.source.kind === 'file' ? 'File source' : 'URL source'}</strong>
          <span className="traffic-source-location">{table.source.location}</span>
          <span className="field-help">
            Updated {new Date(table.source.updatedAt).toLocaleString()}
          </span>
          <div className="action-row runtime-actions">
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                if (table.source!.kind === 'url') void loadUrl(table.source);
                else if (isTauri()) void loadNativeFile(table.source!.location);
                else {
                  refreshFile.current = true;
                  file.current?.click();
                }
              }}
            >
              Update from source
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                reset();
                onImport(detachTrafficSource(table), null);
              }}
            >
              Detach source
            </button>
          </div>
          <p className="field-help">Your added entries and rules are kept during updates.</p>
          {table.rules.some((r) => r.source?.missing) && (
            <p className="field-help">Customized rules missing from the source were kept.</p>
          )}
        </section>
      )}
      <div className="action-row runtime-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            refreshFile.current = false;
            if (isTauri()) void loadNativeFile();
            else file.current?.click();
          }}
        >
          <Upload size={14} /> Open routing file…
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,.jsonc,.txt,application/json,text/plain"
          hidden
          aria-label="Routing file"
          onChange={(e) => void loadFile(e)}
        />
      </div>
      <div className="form-row routing-url-row">
        <label className="editor-field">
          <span>Routing URL</span>
          <input
            aria-label="Routing URL"
            type="url"
            maxLength={8192}
            value={url}
            spellCheck={false}
            onChange={(e) => {
              reset();
              setUrl(e.target.value);
            }}
          />
        </label>
        <button
          className="secondary-button"
          disabled={!url.trim() || busy}
          onClick={() => void loadUrl()}
        >
          <Download size={14} /> Load URL
        </button>
      </div>
      <div className="form-row routing-import-options">
        <label className="editor-checkbox">
          <input
            type="checkbox"
            checked={allowHttp}
            onChange={(e) => {
              reset();
              setAllowHttp(e.target.checked);
            }}
          />{' '}
          Allow HTTP
        </label>
        {isTauri() && (
          <label className="editor-checkbox">
            <input
              type="checkbox"
              checked={viaWayrill}
              onChange={(e) => {
                reset();
                setViaWayrill(e.target.checked);
              }}
            />{' '}
            Download through Wayrill
          </label>
        )}
      </div>
      {busy && (
        <p role="status">
          Loading routing rules…{' '}
          <button className="secondary-button" onClick={reset}>
            Cancel
          </button>
        </p>
      )}
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
            <label className="editor-checkbox">
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
            <label className="editor-checkbox">
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

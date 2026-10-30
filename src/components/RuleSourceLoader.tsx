import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Upload, Download } from 'lucide-react';
import { readImportText } from '../importText';
import { LIMITS, CONFIG_LIMIT_LABEL } from '../limits';
import { downloadRoutingRules } from '../routingDownload';
import type { RuleSource } from '../graph/ruleSourceModel';
import useFileRead from './useFileRead';

export type SourceLocation = Omit<RuleSource, 'version' | 'bindings' | 'updatedAt'>;
export default function RuleSourceLoader({
  source,
  missing,
  onLoad,
  onReset,
  onDetach,
}: {
  source?: RuleSource;
  missing: boolean;
  onLoad: (text: string, name: string, location: SourceLocation, refresh: boolean) => void;
  onReset: () => void;
  onDetach: () => void;
}) {
  const file = useRef<HTMLInputElement>(null),
    refreshFile = useRef(false),
    request = useRef<AbortController | null>(null),
    alert = useRef<HTMLParagraphElement>(null);
  const reads = useFileRead();
  const [url, setUrl] = useState(source?.kind === 'url' ? source.location : ''),
    [allowHttp, setAllowHttp] = useState(source?.allowHttp ?? false),
    [viaWayrill, setViaWayrill] = useState(source?.viaWayrill ?? false);
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState('');
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (problem) alert.current?.focus();
  }, [problem]);
  function reset() {
    reads.cancel();
    request.current?.abort();
    setBusy(false);
    setProblem('');
    onReset();
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
        onLoad(
          text,
          selected.name,
          { kind: 'file', location: selected.name, allowHttp: false, viaWayrill: false },
          updating,
        );
    } catch (error) {
      if (current()) setProblem(error instanceof Error ? error.message : String(error));
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
        onLoad(
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
  async function loadUrl(saved?: RuleSource) {
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
      if (current()) onLoad(text, 'Downloaded routing rules', location, !!saved);
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
  return (
    <>
      {source && (
        <section className="traffic-source-summary" aria-label="Current rule source">
          <strong>{source.kind === 'file' ? 'File source' : 'URL source'}</strong>
          <span className="traffic-source-location">{source.location}</span>
          <span className="field-help">Updated {new Date(source.updatedAt).toLocaleString()}</span>
          <div className="action-row runtime-actions">
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                if (source.kind === 'url') void loadUrl(source);
                else if (isTauri()) void loadNativeFile(source.location);
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
                onDetach();
              }}
            >
              Detach source
            </button>
          </div>
          <p className="field-help">Your added entries and rules are kept during updates.</p>
          {missing && (
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
          onChange={(event) => void loadFile(event)}
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
            onChange={(event) => {
              reset();
              setUrl(event.target.value);
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
        <label className="check-control">
          <input
            type="checkbox"
            checked={allowHttp}
            onChange={(event) => {
              reset();
              setAllowHttp(event.target.checked);
            }}
          />
          Allow HTTP
        </label>
        {isTauri() && (
          <label className="check-control">
            <input
              type="checkbox"
              checked={viaWayrill}
              onChange={(event) => {
                reset();
                setViaWayrill(event.target.checked);
              }}
            />
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
    </>
  );
}

import { boundedText } from '../text';
import { readImportText } from '../importText';
import useModalDialog from './useModalDialog';
import useEditorSave from './useEditorSave';
import useFileRead from './useFileRead';
import { LIMITS, CONFIG_LIMIT_LABEL } from '../limits';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { X, Upload } from 'lucide-react';
import { importXrayConfig } from '../graph/xrayImport';
import {
  fixXrayCapitalization,
  inspectXrayCapitalization,
  type XrayNameCorrection,
} from '../graph/xrayConfigNames';
import { compileRuntimeGraph, type RuntimeCompilation } from '../graph/runtime';
import { diagnoseRuntimeGraph } from '../graph/diagnostics';
import type { GraphState, Diagnostic } from '../graph/types';
type ConversionReview = {
  graph: GraphState;
  compiled: RuntimeCompilation;
  warnings: Diagnostic[];
};
export default function XrayImportDialog({
  applied,
  onImport,
  onClose,
}: {
  applied: Record<string, unknown> | null;
  onImport: (graph: GraphState) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    file = useRef<HTMLInputElement>(null),
    fixButton = useRef<HTMLButtonElement>(null),
    reviewTitle = useRef<HTMLHeadingElement>(null),
    errorText = useRef<HTMLParagraphElement>(null);
  const [text, setText] = useState(''),
    [name, setName] = useState('Imported Xray configuration'),
    [review, setReview] = useState<ConversionReview | null>(null),
    [error, setError] = useState(''),
    [corrections, setCorrections] = useState<XrayNameCorrection[]>([]),
    [fixed, setFixed] = useState<XrayNameCorrection[]>([]),
    [beforeFix, setBeforeFix] = useState<string | null>(null);
  useModalDialog(dialog);
  const { save, saveError } = useEditorSave(onClose);
  const failure = error || saveError;
  const fileRead = useFileRead();
  useEffect(() => {
    if (failure) errorText.current?.focus();
    else if (corrections.length) fixButton.current?.focus();
    else if (fixed.length && review) reviewTitle.current?.focus();
  }, [failure, corrections, fixed, review]);
  const reset = (value: string) => {
    fileRead.cancel();
    setText(value);
    setReview(null);
    setError('');
    setCorrections([]);
    setFixed([]);
    setBeforeFix(null);
  };
  async function load(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    reset(text);
    const isCurrent = fileRead.begin();
    try {
      if (selected.size > LIMITS.configBytes)
        throw new Error(`Xray configurations must be at most ${CONFIG_LIMIT_LABEL}.`);
      const value = await readImportText(selected);
      if (!isCurrent()) return;
      reset(value);
      setName(boundedText(selected.name.replace(/\.(json|jsonc)$/i, ''), 128));
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : 'Could not read this file.');
    }
  }
  const compiled = review?.compiled;
  const warnings = review?.warnings ?? [];
  function preview(value = text) {
    fileRead.cancel();
    setReview(null);
    setCorrections([]);
    if (!name.trim()) {
      setError('Enter a graph name before reviewing the conversion.');
      return;
    }
    try {
      const changes = inspectXrayCapitalization(value);
      if (changes.length) {
        setCorrections(changes);
        setError('');
        return;
      }
      const graph = importXrayConfig(value, name);
      const compiled = compileRuntimeGraph(graph);
      const warnings = diagnoseRuntimeGraph(graph);
      setReview({ graph, compiled, warnings });
      setError('');
    } catch (e) {
      setReview(null);
      setError(e instanceof Error ? e.message : 'Could not import the native configuration.');
    }
  }
  function fixNames() {
    try {
      const repaired = fixXrayCapitalization(text);
      setBeforeFix(text);
      setText(repaired.text);
      setFixed(repaired.changes);
      preview(repaired.text);
    } catch (e) {
      setReview(null);
      setCorrections([]);
      setError(e instanceof Error ? e.message : 'Could not safely fix the field names.');
    }
  }
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window runtime-window xray-import-window"
      aria-labelledby="xray-import-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="xray-import-title">Import Xray configuration</h2>
        </div>
        <button className="icon-button" aria-label="Close Xray import" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="runtime-body">
        <div className="runtime-actions">
          <button className="secondary-button" onClick={() => file.current?.click()}>
            <Upload size={14} /> Open Xray JSON…
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json,.jsonc"
            hidden
            onChange={(e) => void load(e)}
          />
          <button
            className="secondary-button"
            disabled={!applied}
            onClick={() => {
              reset(JSON.stringify(applied, null, 2));
              setName('Applied Xray configuration');
            }}
          >
            Use applied configuration
          </button>
        </div>
        <label className="editor-field">
          <span>Graph name</span>
          <input
            aria-label="Graph name"
            value={name}
            onChange={(e) => {
              fileRead.cancel();
              setName(boundedText(e.target.value, 128));
              setReview(null);
            }}
          />
        </label>
        <div className="editor-field">
          <label htmlFor="xray-import-json">Xray configuration JSON</label>
          <textarea
            id="xray-import-json"
            aria-describedby="xray-import-help"
            rows={10}
            spellCheck={false}
            value={text}
            onChange={(e) => reset(e.target.value)}
            placeholder="Paste complete Xray JSON here, or open a file."
          />
          <small id="xray-import-help">
            JSON comments are accepted. Exports include credentials.
          </small>
        </div>
        <button
          className="secondary-button"
          disabled={!text.trim() || !name.trim()}
          onClick={() => preview()}
        >
          Review conversion
        </button>
        {corrections.length > 0 && (
          <section className="runtime-section" aria-labelledby="xray-name-fixes-title">
            <h3 id="xray-name-fixes-title">Field names need capitalization fixes</h3>
            <p>
              {corrections.length}{' '}
              {corrections.length === 1 ? 'field name differs' : 'field names differ'} from the
              supported spelling. Fixes change field names only; the source file stays unchanged.
            </p>
            <ul>
              {corrections.slice(0, 10).map((change) => (
                <li key={change.path}>
                  <code>{change.path}</code> → <code>{change.to}</code>
                </li>
              ))}
            </ul>
            {corrections.length > 10 && (
              <p>{corrections.length - 10} more field names will be fixed.</p>
            )}
            <button ref={fixButton} className="secondary-button" onClick={fixNames}>
              Fix capitalization in JSON
            </button>
          </section>
        )}
        {fixed.length > 0 && (
          <section className="runtime-section">
            <p role="status">
              Fixed {fixed.length} {fixed.length === 1 ? 'field name' : 'field names'} in the JSON.
              The source file is unchanged.
            </p>
            <button
              className="secondary-button"
              onClick={() => {
                if (beforeFix !== null) {
                  const previous = beforeFix;
                  reset(previous);
                  preview(previous);
                }
              }}
            >
              Undo capitalization fix
            </button>
          </section>
        )}
        {failure && (
          <p ref={errorText} className="runtime-error" role="alert" tabIndex={-1}>
            {failure}
          </p>
        )}
        {review && compiled && (
          <section className="runtime-section">
            <h3 ref={reviewTitle} tabIndex={-1}>
              {fixed.length
                ? 'Round trip preserves the corrected JSON'
                : 'Unedited round trip preserves every JSON value'}
            </h3>
            <p>
              {(
                [
                  [review.graph.nodes.length, 'node'],
                  [review.graph.edges.length, 'connection'],
                  [compiled.summary.listeners.length, 'input'],
                  [compiled.summary.outboundCount, 'outbound'],
                  [compiled.summary.trafficRuleCount, 'ordered rule'],
                  [compiled.summary.dnsServerCount, 'DNS server'],
                ] as const
              )
                .map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`)
                .join(' · ')}
            </p>
            {warnings.map((w, i) => (
              <p key={i} className={w.severity}>
                {w.message}
              </p>
            ))}
          </section>
        )}
      </div>
      <div className="rule-editor-footer">
        <span>Import is undoable · Networking does not change</span>
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={!review}
          onClick={() => {
            if (review) save(() => onImport(review.graph));
          }}
        >
          Import graph
        </button>
      </div>
    </dialog>
  );
}

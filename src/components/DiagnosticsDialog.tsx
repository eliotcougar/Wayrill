import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Download, FolderOpen, Pause, Play, RotateCcw, X } from 'lucide-react';
import useModalDialog from './useModalDialog';
import {
  diagnosticEntries,
  diagnosticSourceId,
  diagnosticSourceNames,
  diagnosticText,
  maskDiagnosticText,
  type DiagnosticSource,
} from '../diagnostics';
import { desktopServiceAvailable, errorText } from '../serviceClient';
import { exportFile } from '../exportFile';
import RoutingLogFilter, { allLogItems, logItemVisible } from './RoutingLogFilter';

type Snapshot = { sources: DiagnosticSource[]; timeMs: number };
const levels = ['error', 'warning', 'info', 'debug', 'trace'];

export default function DiagnosticsDialog({
  onClose,
  maskAddress,
}: {
  onClose: () => void;
  maskAddress: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    output = useRef<HTMLTextAreaElement>(null);
  const [live, setLive] = useState<Snapshot | null>(null),
    [held, setHeld] = useState<Snapshot | null>(null);
  const [sourceVisibility, setSourceVisibility] = useState(allLogItems<string>),
    [levelVisibility, setLevelVisibility] = useState(allLogItems<string>);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [transferError, setTransferError] = useState('');
  const desktop = desktopServiceAvailable();
  useModalDialog(dialog);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await invoke<{ sources: DiagnosticSource[] }>('diagnostics_read', {
          retained: false,
        });
        if (!disposed) {
          setLive((previous) => ({
            sources:
              previous &&
              previous.sources.length === result.sources.length &&
              previous.sources.every((source, i) => {
                const next = result.sources[i];
                return (
                  source.source === next.source &&
                  source.text === next.text &&
                  source.error === next.error &&
                  source.folder === next.folder
                );
              })
                ? previous.sources
                : result.sources,
            timeMs: Date.now(),
          }));
          setError('');
        }
      } catch (failure) {
        if (!disposed) setError(errorText(failure));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [desktop]);
  const display = held ?? live;
  const entries = useMemo(() => diagnosticEntries(display?.sources ?? []), [display?.sources]);
  const sourceChoices = useMemo(() => {
    const choices = new Map<string, string>();
    for (const entry of entries)
      choices.set(
        diagnosticSourceId(entry),
        `${diagnosticSourceNames[entry.source]} / ${entry.component ?? 'Unparsed'}`,
      );
    return [...choices]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entries]);
  const levelChoices = useMemo(
    () =>
      [...new Set([...levels, ...entries.map((entry) => entry.level)])].map((id) => ({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
      })),
    [entries],
  );
  const text = useMemo(
    () =>
      diagnosticText(
        entries.filter(
          (entry) =>
            logItemVisible(sourceVisibility, diagnosticSourceId(entry)) &&
            logItemVisible(levelVisibility, entry.level),
        ),
      ),
    [entries, sourceVisibility, levelVisibility],
  );
  const selectedFiles = new Set(
    entries
      .filter((entry) => logItemVisible(sourceVisibility, diagnosticSourceId(entry)))
      .map((entry) => entry.source),
  );
  const folderSource =
    selectedFiles.size === 1 && selectedFiles.has('desktop') ? 'desktop' : 'service';
  useLayoutEffect(() => {
    if (!held && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [text, held]);
  async function open() {
    setTransferError('');
    try {
      await invoke('diagnostics_open', { source: folderSource });
    } catch (failure) {
      setTransferError(errorText(failure));
    }
  }
  async function save() {
    setSaving(true);
    setTransferError('');
    try {
      const result = await invoke<{ sources: DiagnosticSource[] }>('diagnostics_read', {
        retained: true,
      });
      const grouped = new Map<DiagnosticSource['source'], string[]>();
      for (const entry of diagnosticEntries(result.sources)) {
        if (
          !logItemVisible(sourceVisibility, diagnosticSourceId(entry)) ||
          !logItemVisible(levelVisibility, entry.level)
        )
          continue;
        const lines = grouped.get(entry.source) ?? [];
        lines.push(entry.line);
        grouped.set(entry.source, lines);
      }
      if (!grouped.size) throw new Error('No retained entries match the selected filters.');
      await exportFile(
        'wayrill-diagnostics.json',
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            sources: [...grouped].map(([source, lines]) => ({
              source,
              text: maskDiagnosticText(lines.join('\n') + '\n', maskAddress),
            })),
          },
          null,
          2,
        ),
      );
    } catch (failure) {
      setTransferError(errorText(failure));
    } finally {
      setSaving(false);
    }
  }
  const filtered =
    !sourceVisibility.all ||
    !!sourceVisibility.exceptions.size ||
    !levelVisibility.all ||
    !!levelVisibility.exceptions.size;
  const fileErrors = display?.sources.filter((source) => source.error) ?? [];
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window diagnostics-window"
      onClose={onClose}
      aria-labelledby="diagnostics-title"
    >
      <div className="rule-editor-titlebar">
        <h2 id="diagnostics-title">Application logs</h2>
        <button className="icon-button" aria-label="Close Application logs" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="diagnostics-body">
        <div className="action-row diagnostics-toolbar">
          <RoutingLogFilter
            label="Sources"
            choices={sourceChoices}
            visibility={sourceVisibility}
            onChange={setSourceVisibility}
          />
          <RoutingLogFilter
            label="Levels"
            choices={levelChoices}
            visibility={levelVisibility}
            onChange={setLevelVisibility}
          />
          <button
            className="icon-button"
            aria-label="Reset log filters"
            title="Reset filters"
            disabled={!filtered}
            onClick={() => {
              setSourceVisibility(allLogItems());
              setLevelVisibility(allLogItems());
            }}
          >
            <RotateCcw size={15} />
          </button>
          <button
            className="secondary-button"
            aria-pressed={!!held}
            title="Pause the display only. Collection continues; resume shows the latest retained entries."
            disabled={!live}
            onClick={() => setHeld(held ? null : live)}
          >
            {held ? <Play size={15} /> : <Pause size={15} />}
            {held ? 'Resume display' : 'Pause display'}
          </button>
          <button
            className="secondary-button diagnostics-folder"
            title={`Open ${diagnosticSourceNames[folderSource].toLowerCase()} logs folder`}
            onClick={() => void open()}
            disabled={!desktop}
          >
            <FolderOpen size={15} /> Open folder
          </button>
        </div>
        {!desktop && <p className="notice">Application logs are available in the Windows app.</p>}
        {(error || transferError) && (
          <p role="alert" className="notice notice--error">
            {transferError || error}
          </p>
        )}
        {fileErrors.map((source) => (
          <p role="alert" className="notice notice--error" key={source.source}>
            {diagnosticSourceNames[source.source]}: {source.error}
          </p>
        ))}
        <textarea
          ref={output}
          aria-label="Application log entries"
          className="text-control code-control diagnostics-output"
          readOnly
          value={text}
          placeholder={
            !live && desktop
              ? 'Reading logs…'
              : filtered
                ? 'No entries match the selected filters.'
                : 'No diagnostic entries yet.'
          }
          spellCheck={false}
        />
        <div className="action-row action-row--spread diagnostics-status">
          <span role="status">
            {desktop && display && (
              <>
                {held ? 'Display paused at ' : 'Updated '}
                <time
                  dateTime={new Date(display.timeMs).toISOString()}
                  title={new Date(display.timeMs).toLocaleString()}
                >
                  {new Date(display.timeMs).toLocaleTimeString()}
                </time>
              </>
            )}
          </span>
          <span>Review logs before sharing.</span>
        </div>
      </div>
      <div className="rule-editor-footer">
        <button
          className="secondary-button"
          title="Save retained history matching the selected sources and levels. Global address masking applies."
          onClick={() => void save()}
          disabled={!desktop || !live || saving}
        >
          <Download size={15} /> Save diagnostics…
        </button>
        <button className="primary-button" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}

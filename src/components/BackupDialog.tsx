import { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog';
import { backupRequest, type OpenedBackup } from '../backup/client';
import { MAX_BACKUP_BYTES } from '../backup/codec';
import {
  isBackupFilter,
  type BackupContent,
  type BackupScope,
  type RestoredWorkspace,
  type RestoreSelection,
} from '../backup/model';
import { readPreferences } from '../backup/preferences';
import { exportFile } from '../exportFile';
import { readImportText } from '../importText';
import type { GraphState } from '../graph/types';
import type { Stash } from '../profiles/import';
import './BackupDialog.css';

export interface BackupRequestState {
  mode: 'create' | 'restore';
  targetId?: string;
}
type Snapshot = { graph: GraphState; stash: Stash };
const entryCount = (value: unknown) => {
  const stash = value as { groups?: { entries: unknown[] }[] } | undefined;
  return stash?.groups?.reduce((n, g) => n + g.entries.length, 0) ?? 0;
};
export default function BackupDialog({
  request,
  graph,
  blocked,
  getSnapshot,
  onRestore,
  onClose,
  onSaved,
}: {
  request: BackupRequestState;
  graph: GraphState;
  blocked: boolean;
  getSnapshot: () => Snapshot;
  onRestore: (workspace: RestoredWorkspace, expected: Snapshot) => void;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const creating = request.mode === 'create';
  const [scope, setScope] = useState<BackupScope>(request.targetId ? 'filters' : 'full');
  const filters = graph.nodes.filter((n) => isBackupFilter(n.data.kind));
  const [filterIds, setFilterIds] = useState<string[]>(
    request.targetId ? [request.targetId] : filters.map((n) => n.id),
  );
  const [encrypt, setEncrypt] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [text, setText] = useState('');
  const [encrypted, setEncrypted] = useState(false);
  const [content, setContent] = useState<BackupContent>();
  const [selection, setSelection] = useState<RestoreSelection>({
    graph: false,
    stash: false,
    preferences: false,
    filters: false,
    stashMode: 'merge',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const close = () => {
    operation.current?.abort();
    onClose();
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    try {
      await action(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Backup operation failed.');
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const open = async (source: string, signal: AbortSignal, secret?: string) => {
    const opened = await backupRequest<OpenedBackup>(
      { operation: 'open', text: source, ...(secret === undefined ? {} : { password: secret }) },
      signal,
    );
    signal.throwIfAborted();
    setEncrypted(opened.encrypted);
    if (!opened.content) return;
    const next = opened.content;
    let filterIndex: number | undefined;
    if (request.targetId) {
      const target = getSnapshot().graph.nodes.find((n) => n.id === request.targetId);
      const index = next.filters?.findIndex((f) => f.kind === target?.data.kind) ?? -1;
      if (index < 0) throw new Error('This backup has no compatible filter for this node.');
      filterIndex = index;
    }
    setContent(next);
    setPassword('');
    setSelection({
      graph: !!next.graph,
      stash: !!next.stash,
      preferences: !!next.preferences,
      filters: !!next.filters,
      stashMode: next.graph && next.stash ? 'replace' : 'merge',
      targetId: request.targetId,
      filterIndex,
    });
  };
  const create = () =>
    run(async (signal) => {
      if (encrypt && (password.length < 8 || password !== confirm))
        throw new Error('Use at least 8 characters and matching passwords.');
      const snapshot = getSnapshot();
      const backup = await backupRequest<string>(
        {
          operation: 'create',
          scope,
          ...snapshot,
          preferences: scope === 'full' ? readPreferences() : {},
          filterIds,
          ...(encrypt ? { password } : {}),
        },
        signal,
      );
      signal.throwIfAborted();
      const saved = await exportFile(
        `wayrill-${scope}-${new Date().toISOString().slice(0, 10)}.backup.json`,
        backup,
      );
      signal.throwIfAborted();
      if (saved) {
        setPassword('');
        setConfirm('');
        onSaved('Backup saved.');
        onClose();
      }
    });
  const restore = () =>
    run(async (signal) => {
      if (!content || blocked) return;
      const expected = getSnapshot();
      const restored = await backupRequest<RestoredWorkspace>(
        {
          operation: 'restore',
          content,
          selection,
          graph:
            selection.graph || selection.filters || selection.stash
              ? expected.graph
              : { name: '', nodes: [], edges: [] },
          stash:
            selection.graph || selection.stash
              ? expected.stash
              : { format: 'wayrill.stash', version: 3, groups: [] },
        },
        signal,
      );
      signal.throwIfAborted();
      onRestore(restored, expected);
      onSaved(
        restored.graph || restored.stash
          ? 'Restored to the draft. Apply when ready. Undo restores the previous Graph and Stash.'
          : restored.preferences
            ? 'Application preferences restored.'
            : 'The selected configuration already matches the backup.',
      );
      onClose();
    });
  const canRestore =
    content && (selection.graph || selection.stash || selection.preferences || selection.filters);
  const selectedFilter =
    content?.filters &&
    (selection.filterIndex === undefined && content.filters.length === 1
      ? content.filters[0]
      : content.filters[selection.filterIndex ?? -1]);
  return (
    <Dialog
      className="backup-dialog"
      title={creating ? 'Back up configuration' : 'Restore configuration'}
      onClose={close}
      footer={
        <div className="backup-actions">
          <button className="secondary-button" onClick={close}>
            {busy ? 'Cancel' : 'Close'}
          </button>
          {creating ? (
            <button
              className="primary-button"
              disabled={
                busy ||
                (scope === 'filters' && !filterIds.length) ||
                (encrypt && (password.length < 8 || password !== confirm))
              }
              onClick={() => void create()}
            >
              {busy ? 'Preparing…' : 'Save backup…'}
            </button>
          ) : content ? (
            <button
              className="primary-button"
              disabled={busy || blocked || !canRestore}
              onClick={() => void restore()}
            >
              {busy ? 'Preparing…' : 'Restore to draft'}
            </button>
          ) : encrypted && text ? (
            <button
              className="primary-button"
              disabled={busy || !password}
              onClick={() => void run((signal) => open(text, signal, password))}
            >
              {busy ? 'Opening…' : 'Unlock backup'}
            </button>
          ) : null}
        </div>
      }
    >
      <div className="backup-content">
        {creating ? (
          <>
            <label className="editor-field">
              <span>Back up</span>
              <select
                aria-label="Backup scope"
                value={scope}
                disabled={busy}
                onChange={(e) => setScope(e.target.value as BackupScope)}
              >
                <option value="full">Full configuration</option>
                <option value="graph">Graph</option>
                <option value="stash">Stash</option>
                <option value="filters">Filter nodes</option>
              </select>
            </label>
            {scope === 'full' && (
              <p className="field-help">
                Graph, Stash, defaults, resource sources, appearance, test settings and statistics
                preferences.
              </p>
            )}
            {scope === 'graph' && <p className="field-help">Includes linked Stash dependencies.</p>}
            {scope === 'filters' && (
              <div className="backup-filter-list" aria-label="Filters to back up">
                <label className="editor-check">
                  <input
                    type="checkbox"
                    disabled={busy || !filters.length}
                    checked={filters.length > 0 && filterIds.length === filters.length}
                    onChange={(e) => setFilterIds(e.target.checked ? filters.map((n) => n.id) : [])}
                  />
                  All
                </label>
                {filters.map((n) => (
                  <label className="editor-check" key={n.id}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={filterIds.includes(n.id)}
                      onChange={(e) =>
                        setFilterIds((ids) =>
                          e.target.checked ? [...ids, n.id] : ids.filter((id) => id !== n.id),
                        )
                      }
                    />
                    <span>
                      {n.data.label}
                      <small>
                        {n.data.kind === 'routing-filter' ? 'Traffic filter' : 'DNS filter'}
                      </small>
                    </span>
                  </label>
                ))}
                {!filters.length && <p>No Traffic or DNS routing filters on this graph.</p>}
              </div>
            )}
            <label className="editor-check">
              <input
                type="checkbox"
                checked={encrypt}
                disabled={busy}
                onChange={(e) => {
                  setEncrypt(e.target.checked);
                  setPassword('');
                  setConfirm('');
                }}
              />
              Encrypt with a password
            </label>
            {encrypt ? (
              <div className="backup-passwords">
                <label className="editor-field">
                  <span>Password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    maxLength={1024}
                    disabled={busy}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label className="editor-field">
                  <span>Confirm password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    maxLength={1024}
                    disabled={busy}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
                <p className="field-help">
                  At least 8 characters. A lost password cannot be recovered.
                </p>
              </div>
            ) : (
              <p className="field-help">
                The backup will contain readable credentials and subscription URLs.
              </p>
            )}
          </>
        ) : (
          <>
            <label className="editor-field">
              <span>Backup file</span>
              <input
                ref={file}
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  if (!selected) return;
                  setContent(undefined);
                  setText('');
                  setEncrypted(false);
                  setPassword('');
                  void run(async (signal) => {
                    if (selected.size > MAX_BACKUP_BYTES)
                      throw new Error('Backup files must be smaller than 192 MiB.');
                    const source = await readImportText(selected);
                    signal.throwIfAborted();
                    setText(source);
                    await open(source, signal);
                  });
                }}
              />
            </label>
            {encrypted && !content && (
              <label className="editor-field">
                <span>Backup password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  maxLength={1024}
                  disabled={busy}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && password && !busy)
                      void run((signal) => open(text, signal, password));
                  }}
                />
              </label>
            )}
            {content && (
              <>
                <p className="field-help">
                  Wayrill {content.appVersion} · {new Date(content.createdAt).toLocaleString()} ·{' '}
                  {encrypted ? 'Encrypted' : 'Not encrypted'}
                </p>
                <fieldset className="backup-components">
                  <legend>Restore</legend>
                  {content.graph && (
                    <label className="editor-check">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selection.graph}
                        onChange={(e) => setSelection({ ...selection, graph: e.target.checked })}
                      />
                      Graph: {content.graph.name} · {content.graph.nodes.length} nodes
                    </label>
                  )}
                  {content.stash !== undefined && (
                    <label className="editor-check">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selection.stash}
                        onChange={(e) => setSelection({ ...selection, stash: e.target.checked })}
                      />
                      Stash · {entryCount(content.stash).toLocaleString()} entries
                    </label>
                  )}
                  {content.preferences && (
                    <label className="editor-check">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selection.preferences}
                        onChange={(e) =>
                          setSelection({ ...selection, preferences: e.target.checked })
                        }
                      />
                      Application preferences
                    </label>
                  )}
                  {content.filters && (
                    <label className="editor-check">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selection.filters}
                        onChange={(e) => setSelection({ ...selection, filters: e.target.checked })}
                      />
                      Filter nodes · {content.filters.length}
                    </label>
                  )}
                </fieldset>
                {selection.stash && (
                  <label className="editor-field">
                    <span>Stash</span>
                    <select
                      aria-label="Stash restore mode"
                      value={selection.stashMode}
                      disabled={busy}
                      onChange={(e) =>
                        setSelection({
                          ...selection,
                          stashMode: e.target.value as 'merge' | 'replace',
                        })
                      }
                    >
                      <option value="merge">Merge with current Stash</option>
                      <option value="replace">Replace current Stash</option>
                    </select>
                  </label>
                )}
                {selection.stash && selection.stashMode === 'replace' && (
                  <p className="field-help">
                    Replaces the current Stash. Outbounds used by the remaining graph are retained
                    as manual entries.
                  </p>
                )}
                {selection.filters && content.filters && (
                  <>
                    <label className="editor-field">
                      <span>Filter from backup</span>
                      <select
                        aria-label="Filter from backup"
                        disabled={busy}
                        value={selection.filterIndex ?? ''}
                        onChange={(e) =>
                          setSelection({
                            ...selection,
                            filterIndex: e.target.value === '' ? undefined : Number(e.target.value),
                            targetId: undefined,
                          })
                        }
                      >
                        <option value="">All filters</option>
                        {content.filters.map((f, i) => (
                          <option key={i} value={i}>
                            {f.label} · {f.kind === 'routing-filter' ? 'Traffic' : 'DNS'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="editor-field">
                      <span>Destination</span>
                      <select
                        aria-label="Restore destination"
                        disabled={busy}
                        value={selection.targetId ?? ''}
                        onChange={(e) =>
                          setSelection({ ...selection, targetId: e.target.value || undefined })
                        }
                      >
                        <option value="">Add new filter nodes</option>
                        {selectedFilter &&
                          filters
                            .filter((n) => n.data.kind === selectedFilter.kind)
                            .map((n) => (
                              <option value={n.id} key={n.id}>
                                Replace {n.data.label}
                              </option>
                            ))}
                      </select>
                    </label>
                    <p className="field-help">
                      Matching output names keep their connections. Removed outputs disconnect their
                      links. New nodes start unconnected.
                    </p>
                  </>
                )}
                <p className="field-help">
                  Routing stays unchanged until Apply. Windows assignments, startup/protection
                  policy and external files are not restored.
                </p>
                {blocked && <p role="status">Wait for the current routing operation to finish.</p>}
              </>
            )}
          </>
        )}
        {busy && <p role="status">Processing backup…</p>}
        {error && (
          <p className="runtime-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

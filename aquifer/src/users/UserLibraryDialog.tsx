import { useEffect, useRef, useState } from 'react';
import { Download, Plus, Upload, Users, X } from 'lucide-react';
import { errorMessage } from '../remoteClient';
import { cloneJson } from '../graph/xrayJson';
import {
  emptyLibrary,
  mergeUserLibraries,
  newUserSet,
  parseUserLibrary,
  sameSet,
  setProblem,
  userProtocols,
  USER_LIMITS,
  type UserLibrary,
  type UserProtocol,
  type UserSet,
  type UserWorkspace,
} from './model';
import { exportJson } from './storage';
import UserSetEditor from './UserSetEditor';

export default function UserLibraryDialog({
  library,
  workspace,
  initial,
  protocol,
  targetName,
  onSave,
  onReplace,
  onUse,
  onClose,
}: {
  library: UserLibrary;
  workspace: UserWorkspace | null;
  initial: UserSet | null;
  protocol?: UserProtocol;
  targetName?: string;
  onSave: (set: UserSet) => Promise<void>;
  onReplace: (library: UserLibrary) => Promise<void>;
  onUse: (set: UserSet) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    file = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<UserSet | null>(initial ? cloneJson(initial) : null);
  const [pendingJson, setPendingJson] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const sets = [
    ...(workspace?.sets ?? []),
    ...library.sets.filter((set) => !workspace?.sets.some((item) => item.id === set.id)),
  ];
  const saved = sets.find((s) => s.id === draft?.id);
  const dirty = pendingJson || (!!draft && (!saved || !sameSet(saved, draft)));
  const problem = draft ? setProblem(draft) : null;
  const stored = library.sets.find((set) => set.id === draft?.id);
  const graphSet = workspace?.sets.find((set) => set.id === draft?.id);
  const libraryChanged = !!draft && (!stored || !sameSet(stored, draft));
  const graphChanged = !!draft && (!graphSet || !sameSet(graphSet, draft));
  const close = () => {
    if (
      !dirty ||
      window.confirm(
        stored && draft && sameSet(stored, draft)
          ? 'Close without applying this set to the graph? Its library copy is saved.'
          : 'Discard unsaved changes to this user set?',
      )
    )
      onClose();
  };
  const choose = (set: UserSet) => {
    if (
      dirty &&
      (pendingJson || !stored || !draft || !sameSet(stored, draft)) &&
      !window.confirm('Discard unsaved changes to this user set?')
    )
      return;
    setDraft(cloneJson(set));
    setEditorRevision((value) => value + 1);
    setError('');
    setNotice('');
  };
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (selected: File) => {
    if (selected.size > USER_LIMITS.bytes) throw new Error('User-set files must be at most 8 MiB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer());
    const result = mergeUserLibraries(library, parseUserLibrary(text));
    await onReplace(result.library);
    setNotice(
      `${result.added} sets imported · ${result.skipped} unchanged. Existing sets were preserved.`,
    );
  };
  const matches = sets.filter(
    (set) =>
      (!protocol || protocol === set.protocol) &&
      `${set.name} ${userProtocols[set.protocol]}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <dialog
      ref={dialog}
      className="user-library-dialog"
      aria-label="User sets"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="user-dialog-header">
        <h2>
          <Users size={19} />
          User sets{targetName && <small>Assign to {targetName}</small>}
        </h2>
        <button
          className="icon-button"
          aria-label="Close user sets"
          disabled={busy}
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      <div className="user-library-tools">
        <button
          disabled={busy}
          onClick={() => {
            if (dirty && !window.confirm('Discard unsaved changes to this user set?')) return;
            setDraft(newUserSet(protocol));
            setError('');
            setNotice('');
          }}
        >
          <Plus size={16} />
          New set
        </button>
        <button disabled={busy} onClick={() => file.current?.click()}>
          <Upload size={16} />
          Import
        </button>
        <button
          disabled={busy || !library.sets.length}
          onClick={() => {
            void perform(() =>
              exportJson('wayrill-user-sets.json', JSON.stringify(library, null, 2)),
            );
          }}
        >
          <Download size={16} />
          Export library
        </button>
        <input
          hidden
          ref={file}
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            e.target.value = '';
            if (selected) void perform(() => importFile(selected));
          }}
        />
        <span className="muted">Exports include credentials.</span>
      </div>
      <div className="user-library-body">
        <nav aria-label="User sets library">
          <input
            aria-label="Find user sets"
            placeholder="Find sets"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="user-set-list">
            {matches.map((set) => (
              <button
                key={set.id}
                disabled={busy}
                className={draft?.id === set.id ? 'active' : ''}
                aria-pressed={draft?.id === set.id}
                onClick={() => choose(set)}
              >
                <strong>{draft?.id === set.id ? draft.name : set.name}</strong>
                <span>
                  {userProtocols[set.protocol]} ·{' '}
                  {draft?.id === set.id ? draft.users.length : set.users.length} users
                </span>
                {!library.sets.some((s) => s.id === set.id) && (
                  <small>From this configuration</small>
                )}
              </button>
            ))}
            {!matches.length && (
              <p className="muted">
                {protocol ? 'No compatible user sets.' : 'No saved user sets.'}
              </p>
            )}
          </div>
        </nav>
        <div className="user-library-edit" aria-busy={busy}>
          {draft && stored && graphSet && !sameSet(stored, graphSet) && (
            <div className="user-version-actions">
              <span>Graph and library versions differ.</span>
              <button disabled={busy || sameSet(draft, stored)} onClick={() => choose(stored)}>
                Load library version
              </button>
              <button disabled={busy || sameSet(draft, graphSet)} onClick={() => choose(graphSet)}>
                Load graph version
              </button>
            </div>
          )}
          {draft ? (
            <UserSetEditor
              key={`${draft.id}:${editorRevision}`}
              value={draft}
              isNew={!saved}
              onChange={setDraft}
              onPendingJson={setPendingJson}
            />
          ) : (
            <div className="user-library-empty">
              <Users size={36} />
              <p>Choose a set or create one.</p>
            </div>
          )}
        </div>
      </div>
      {(error || notice || problem) && (
        <div
          className={error || problem ? 'user-dialog-message user-error' : 'user-dialog-message'}
          role={error || problem ? 'alert' : 'status'}
        >
          {error || problem || notice}
        </div>
      )}
      <footer className="user-dialog-footer">
        <div className="user-set-extra-actions">
          {draft && (
            <button
              disabled={busy || !!problem || pendingJson}
              onClick={() => {
                void perform(() =>
                  exportJson(
                    'wayrill-user-set.json',
                    JSON.stringify({ ...emptyLibrary(), sets: [draft] }, null, 2),
                  ),
                );
              }}
            >
              Export set
            </button>
          )}
          {draft && library.sets.some((s) => s.id === draft.id) && (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Remove this set from the library? Its current graph assignments will remain.',
                  )
                )
                  void perform(async () => {
                    await onReplace({
                      ...library,
                      sets: library.sets.filter((s) => s.id !== draft.id),
                    });
                    setDraft(null);
                  });
              }}
            >
              Remove from library
            </button>
          )}
        </div>
        <span className="muted user-usage">
          {draft &&
            workspace &&
            `${workspace.bindings.filter((b) => b.set === draft.id).length} connected inbounds`}
        </span>
        <button disabled={busy} onClick={close}>
          Close
        </button>
        <button
          className={!workspace ? 'primary-button' : undefined}
          disabled={busy || !draft || !!problem || pendingJson || !libraryChanged}
          onClick={() => {
            if (draft)
              void perform(async () => {
                await onSave(draft);
                setNotice(
                  workspace
                    ? 'Saved to library. Graph changes are applied separately.'
                    : 'Saved to library.',
                );
              });
          }}
        >
          {busy ? 'Saving…' : 'Save to library'}
        </button>
        {workspace && (
          <button
            className={workspace ? 'primary-button' : undefined}
            disabled={
              busy ||
              !draft ||
              !!problem ||
              !workspace ||
              pendingJson ||
              (!targetName && !graphChanged)
            }
            onClick={() => {
              if (draft) {
                try {
                  onUse(draft);
                  onClose();
                } catch (reason) {
                  setError(errorMessage(reason));
                }
              }
            }}
          >
            {targetName ? 'Assign to inbound' : graphSet ? 'Apply to graph' : 'Add to graph'}
          </button>
        )}
      </footer>
    </dialog>
  );
}

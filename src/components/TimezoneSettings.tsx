import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import Dialog from './Dialog';
import { desktopServiceAvailable, errorText, serviceCall } from '../serviceClient';
import './TimezoneSettings.css';

type Selection = { groupId: string; entryId: string; version: number };
type Policy = {
  mode: 'off' | 'manual' | 'main' | 'custom';
  zone: string;
  name?: string;
  ip?: string;
  selection?: Selection;
};
type Application = {
  id: string;
  path: string;
  name?: string;
  package?: string;
  revision: number;
  policy: Policy;
  startup?: boolean;
  status?: { phase: string; message?: string };
};
type Snapshot = {
  browsers: Application[];
  processes?: { path: string }[];
  packages?: { family: string; name: string }[];
  error?: string;
};
type Choice = Pick<Selection, 'groupId' | 'entryId'> & { name: string };
type ChoicePage = {
  version: number;
  groupId: string | null;
  groups: { id: string; name: string }[];
  items: Choice[];
  selected: Choice | null;
  more: boolean;
};
const choiceKey = (entry: Pick<Selection, 'groupId' | 'entryId'>) =>
  JSON.stringify([entry.groupId, entry.entryId]);
const zones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
const modes = { off: 'Off', manual: 'Manual', main: 'Main outbound', custom: 'Custom outbound' };

export default function TimezoneSettings({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  // Capture the displayed revision, independently of background inventory polls.
  const [editor, setEditor] = useState<Application>();
  const [mode, setMode] = useState<Policy['mode']>('manual');
  const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [startup, setStartup] = useState(false);
  const [kind, setKind] = useState('executable');
  const [target, setTarget] = useState('');
  const [choices, setChoices] = useState<ChoicePage>();
  const [selection, setSelection] = useState<Selection>();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const working = useRef(false),
    alive = useRef(false),
    readToken = useRef(0),
    choiceToken = useRef(0),
    searchTimer = useRef<number | undefined>(undefined);
  const desktop = desktopServiceAvailable();
  useEffect(() => {
    let active = true,
      reading = false;
    alive.current = true;
    const load = async () => {
      if (!desktop || working.current || reading) return;
      reading = true;
      const token = ++readToken.current;
      try {
        const value = await serviceCall<Snapshot>('browserTimezone.list');
        if (active && token === readToken.current) {
          setSnapshot(value);
          setLoadError('');
        }
      } catch (reason) {
        if (active && token === readToken.current) setLoadError(errorText(reason));
      } finally {
        reading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => {
      active = false;
      alive.current = false;
      window.clearInterval(timer);
      window.clearTimeout(searchTimer.current);
    };
  }, [desktop]);
  const perform = async (action: () => Promise<Snapshot>, success = '') => {
    if (working.current) return;
    working.current = true;
    ++readToken.current;
    setBusy(true);
    setError('');
    setLoadError('');
    setMessage('');
    try {
      const value = await action();
      if (alive.current) {
        ++choiceToken.current;
        setSnapshot(value);
        setEditor(undefined);
        setError('');
        setMessage(success);
      }
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const loadChoices = (selected?: Selection, query = '', groupId = '', delay = 0) => {
    window.clearTimeout(searchTimer.current);
    const token = ++choiceToken.current;
    setSearching(true);
    setError('');
    const read = async () => {
      if (!alive.current || token !== choiceToken.current) return;
      try {
        const page = await serviceCall<ChoicePage>('subscriptions.timezoneChoices', {
          query,
          ...(groupId ? { groupId } : {}),
          ...(selected ? { selected } : {}),
        });
        if (!alive.current || token !== choiceToken.current) return;
        setChoices(page);
        setGroup(page.groupId ?? '');
        setSelection(
          page.selected
            ? {
                groupId: page.selected.groupId,
                entryId: page.selected.entryId,
                version: page.version,
              }
            : undefined,
        );
      } catch (reason) {
        if (alive.current && token === choiceToken.current) {
          setChoices(undefined);
          setError(errorText(reason));
        }
      } finally {
        if (alive.current && token === choiceToken.current) setSearching(false);
      }
    };
    if (delay) searchTimer.current = window.setTimeout(() => void read(), delay);
    else void read();
  };
  const save = async (): Promise<Snapshot> => {
    if (!editor) throw new Error('Select an application first.');
    let policy: Policy = { mode, zone: mode === 'off' ? '' : zone };
    if (mode === 'main' || mode === 'custom') {
      const selected = mode === 'custom' ? selection : undefined;
      if (mode === 'custom' && !selected) throw new Error('Choose an outbound from Stash.');
      const started = await serviceCall<{ job: number; revision: number; name?: string }>(
        'timezone.probeStart',
        selected ? { selection: selected } : {},
      );
      const deadline = Date.now() + 30000;
      let completed = false;
      try {
        for (;;) {
          if (!alive.current || Date.now() >= deadline)
            throw new Error('Timezone lookup was canceled or timed out.');
          const current = await serviceCall<{
            busy: boolean;
            results: { timezone?: string; ip?: string; name?: string }[];
          }>('outbounds.testGet', { job: started.job });
          if (!current.busy) {
            completed = true;
            const result = current.results[0];
            if (!result?.timezone || !result.ip)
              throw new Error('Cannot determine the outbound’s exit timezone.');
            const config = await serviceCall<{ revision: number }>('config.get');
            const stash = selected
              ? await serviceCall<{ version: number }>('subscriptions.status')
              : undefined;
            if (
              config.revision !== started.revision ||
              (selected && stash?.version !== selected.version)
            )
              throw new Error('Outbound settings changed during lookup. Try again.');
            policy = {
              mode,
              zone: result.timezone,
              ip: result.ip,
              name: result.name || started.name,
              ...(selected ? { selection: selected } : {}),
            };
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        }
      } finally {
        if (!completed)
          await serviceCall('outbounds.testCancel', { job: started.job }).catch(() => {});
      }
    }
    if (!alive.current) throw new Error('Timezone lookup was canceled.');
    return serviceCall<Snapshot>('browserTimezone.set', {
      id: editor.id,
      expectedRevision: editor.revision,
      policy,
      startup,
    });
  };
  const edit = (application: Application) => {
    ++choiceToken.current;
    setEditor(application);
    setMode(application.policy.mode);
    setStartup(!!application.startup);
    setZone(application.policy.zone || zone);
    setMessage('');
    setError('');
    setChoices(undefined);
    setSelection(application.policy.selection);
    setQuery('');
    setGroup('');
    setSearching(false);
    if (application.policy.mode === 'custom') loadChoices(application.policy.selection);
  };
  const canSave =
    mode !== 'custom' || (!searching && !!choices && selection?.version === choices.version);
  const retainedChoice = choices?.selected;
  const labelChoice = (entry: Choice) => {
    const group = choices?.groups.find((group) => group.id === entry.groupId);
    return group ? `${group.name} · ${entry.name}` : entry.name;
  };
  return (
    <Dialog
      title="Timezone spoofing"
      onClose={onClose}
      className="timezone-settings"
      footer={
        editor ? (
          <>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                ++choiceToken.current;
                setEditor(undefined);
              }}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={busy || !canSave}
              onClick={() =>
                void perform(
                  save,
                  'Saved. The service applies this automatically, including on future launches. Reload pages or restart apps that cache their timezone.',
                )
              }
            >
              {busy ? 'Applying…' : 'Save'}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="timezone-settings-content">
        <p>Give each application its own timezone. Windows timezone and UTC stay unchanged.</p>
        <p className="field-help">
          The service watches app launches; Companion and routing can be off. It supports 32-bit and
          64-bit apps on x64 Windows. Restart Firefox after changing its setting. Protected apps,
          explicit timezone settings and cached values may not follow the override.
        </p>
        <div className="section-heading">
          <h3>Applications and detected browsers</h3>
          <button
            className="icon-button"
            aria-label="Refresh browser timezones"
            disabled={!desktop || busy}
            onClick={() => void perform(() => serviceCall<Snapshot>('browserTimezone.refresh'))}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {desktop && (
          <div className="timezone-add">
            <label className="editor-field">
              <span>Add application</span>
              <select
                aria-label="Application type"
                value={kind}
                disabled={busy}
                onChange={(event) => {
                  setKind(event.target.value);
                  setTarget('');
                }}
              >
                <option value="executable">Executable</option>
                <option value="running">Running application</option>
                <option value="package">Installed package</option>
              </select>
            </label>
            <div className="timezone-add-controls">
              {kind === 'executable' ? (
                <>
                  <input
                    className="text-control"
                    aria-label="Executable path"
                    value={target}
                    disabled={busy}
                    placeholder="C:\Program Files\App\app.exe"
                    onChange={(event) => setTarget(event.target.value)}
                  />
                  <button
                    className="icon-button"
                    aria-label="Browse executable"
                    disabled={busy}
                    onClick={() => {
                      void invoke<string | null>('process_picker', { mode: 'path' })
                        .then((path) => {
                          if (alive.current && path) setTarget(path);
                        })
                        .catch((reason) => {
                          if (alive.current) setError(errorText(reason));
                        });
                    }}
                  >
                    <FolderOpen size={16} />
                  </button>
                </>
              ) : (
                <select
                  className="text-control"
                  aria-label="Application"
                  value={target}
                  disabled={busy}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="">Choose an application…</option>
                  {kind === 'package'
                    ? snapshot?.packages?.map((item) => (
                        <option key={item.family} value={item.family}>
                          {item.name}
                        </option>
                      ))
                    : [...new Set(snapshot?.processes?.map((item) => item.path))]
                        .sort()
                        .map((path) => (
                          <option key={path} value={path}>
                            {path}
                          </option>
                        ))}
                </select>
              )}
              <button
                className="secondary-button"
                disabled={busy || !target.trim()}
                onClick={() =>
                  void perform(
                    () =>
                      serviceCall<Snapshot>(
                        'browserTimezone.add',
                        kind === 'package' ? { package: target } : { path: target.trim() },
                      ),
                    'Added. Choose Edit to configure its timezone.',
                  )
                }
              >
                <Plus size={16} />
                Add
              </button>
            </div>
          </div>
        )}
        {!desktop ? (
          <p role="status">Open the installed Windows app to manage timezones.</p>
        ) : !snapshot ? (
          <p role="status">
            {error || loadError
              ? 'Unable to read application settings.'
              : 'Reading application settings…'}
          </p>
        ) : (
          <div className="timezone-browser-list">
            {!snapshot.browsers.length && (
              <p role="status">Discovering browsers… You can also add an application above.</p>
            )}
            {snapshot.browsers.map((application) => (
              <section key={application.id} className="timezone-browser">
                <div className="timezone-browser-heading">
                  <div>
                    <strong>{application.name || application.path.split(/[\\/]/).at(-1)}</strong>
                    <p className="field-help">{application.path}</p>
                    <span>
                      {modes[application.policy.mode]}
                      {application.policy.zone ? ` · ${application.policy.zone}` : ''}
                      {application.policy.name ? ` · ${application.policy.name}` : ''}
                    </span>
                    {application.revision > 0 && (
                      <p className="field-help" role="status">
                        {application.status?.message ||
                          (application.status?.phase === 'applied'
                            ? 'Native timezone override applied'
                            : 'Waiting for application to launch')}
                      </p>
                    )}
                  </div>
                  <div className="button-row">
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => edit(application)}
                    >
                      Edit
                    </button>
                    {application.revision > 0 && (
                      <button
                        className="icon-button"
                        aria-label={`Remove ${application.path}`}
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () =>
                              serviceCall<Snapshot>('browserTimezone.remove', {
                                id: application.id,
                                expectedRevision: application.revision,
                                policy: { mode: 'off', zone: '' },
                              }),
                            /(^|[\\/])firefox\.exe$/i.test(application.path)
                              ? 'Override removed. Restart Firefox to apply the change.'
                              : 'Application override removed.',
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
                {editor?.id === application.id && (
                  <div className="timezone-browser-editor">
                    <label className="editor-field">
                      <span>Initialization</span>
                      <select
                        value={startup ? 'startup' : 'auto'}
                        disabled={busy}
                        onChange={(event) => setStartup(event.target.value === 'startup')}
                      >
                        <option value="auto">Automatic</option>
                        <option value="startup">Before the app starts</option>
                      </select>
                    </label>
                    <p className="field-help">
                      Automatic recognizes common runtimes that cache timezones. Choose startup
                      initialization for other apps that keep old clock values. Fully quit and
                      reopen the app after changing initialization.
                    </p>
                    <label className="editor-field">
                      <span>Mode</span>
                      <select
                        value={mode}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.target.value as Policy['mode'];
                          setMode(value);
                          setError('');
                          if (value !== 'custom') ++choiceToken.current;
                          else loadChoices(selection, query, group);
                        }}
                      >
                        {Object.entries(modes).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {mode === 'manual' && (
                      <label className="editor-field">
                        <span>Timezone</span>
                        <select
                          value={zone}
                          disabled={busy}
                          onChange={(event) => setZone(event.target.value)}
                        >
                          {[...new Set([...zones, zone])].map((value) => (
                            <option key={value} value={value}>
                              {value.replaceAll('_', ' ')}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {mode === 'custom' && (
                      <>
                        <label className="editor-field">
                          <span>Stash group</span>
                          <select
                            value={group}
                            disabled={busy}
                            onChange={(event) => {
                              setGroup(event.target.value);
                              loadChoices(selection, query, event.target.value);
                            }}
                          >
                            <option value="">All groups</option>
                            {choices?.groups.map((group) => (
                              <option key={group.id} value={group.id}>
                                {group.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="editor-field">
                          <span>Find an outbound</span>
                          <input
                            className="text-control"
                            type="search"
                            value={query}
                            disabled={busy}
                            onChange={(event) => {
                              setQuery(event.target.value);
                              loadChoices(selection, event.target.value, group, 250);
                            }}
                          />
                        </label>
                        <label className="editor-field">
                          <span>Stash outbound</span>
                          <select
                            value={selection ? choiceKey(selection) : ''}
                            disabled={busy || searching || !choices}
                            onChange={(event) => {
                              const item = choices?.items.find(
                                (item) => choiceKey(item) === event.target.value,
                              );
                              setSelection(
                                item && choices
                                  ? {
                                      groupId: item.groupId,
                                      entryId: item.entryId,
                                      version: choices.version,
                                    }
                                  : undefined,
                              );
                            }}
                          >
                            <option value="">
                              {searching ? 'Reading Stash…' : 'Choose an outbound…'}
                            </option>
                            {choices?.items.map((item) => (
                              <option key={choiceKey(item)} value={choiceKey(item)}>
                                {labelChoice(item)}
                              </option>
                            ))}
                            {retainedChoice &&
                              !choices?.items.some(
                                (item) => choiceKey(item) === choiceKey(retainedChoice),
                              ) && (
                                <option value={choiceKey(retainedChoice)} disabled>
                                  {labelChoice(retainedChoice)}
                                </option>
                              )}
                          </select>
                        </label>
                        {choices?.more && (
                          <p className="field-help">
                            Showing 200 results. Choose a group or refine the search.
                          </p>
                        )}
                      </>
                    )}
                    {(mode === 'main' || mode === 'custom') && (
                      <p className="field-help">
                        Save looks up the selected outbound’s exit timezone. The resolved timezone
                        persists through routing restarts.
                      </p>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
        {message && <p role="status">{message}</p>}
        {(error || loadError || snapshot?.error) && (
          <p className="error" role="alert">
            {error || loadError || snapshot?.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

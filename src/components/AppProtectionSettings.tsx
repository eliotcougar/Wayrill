import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { desktopServiceAvailable, errorText, serviceCall } from '../serviceClient';
import { useWindowsCatalog } from './useWindowsCatalog';

export type ProtectionTarget = {
  kind: 'executable' | 'package';
  value: string;
};
export type ProtectionConfig = {
  enabled: boolean;
  applications: ProtectionTarget[];
};
export type ProtectionSnapshot = {
  version: string;
  config: ProtectionConfig;
  phase: 'idle' | 'restart' | 'recovery' | 'upgrade';
  blocked: boolean;
  error: { message: string } | null;
};
const identity = (target: ProtectionTarget) => `${target.kind}:${target.value.toLowerCase()}`;

export default function AppProtectionSettings({
  onBusyChange,
  onRuntimeRefresh,
}: {
  onBusyChange: (busy: boolean) => void;
  onRuntimeRefresh: () => Promise<unknown>;
}) {
  const { catalog, loading, error: catalogError, refresh: refreshCatalog } = useWindowsCatalog();
  const [snapshot, setSnapshot] = useState<ProtectionSnapshot | null>(null);
  const [draft, setDraft] = useState<ProtectionConfig>({
    enabled: false,
    applications: [],
  });
  const [version, setVersion] = useState('');
  const [kind, setKind] = useState<ProtectionTarget['kind']>('executable');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    loaded = useRef(false),
    edited = useRef(false),
    readVersion = useRef(0);
  const desktop = desktopServiceAvailable();
  const listLocked = snapshot !== null && snapshot.phase !== 'idle';
  useEffect(() => {
    alive.current = true;
    if (!desktop) return;
    let requestActive = false,
      active = true;
    const load = async (initial: boolean) => {
      if (working.current || requestActive) return;
      requestActive = true;
      const request = ++readVersion.current;
      try {
        const current = await serviceCall<ProtectionSnapshot>('appProtection.get');
        if (!active || !alive.current || request !== readVersion.current) return;
        setSnapshot(current);
        if (initial || !loaded.current || !edited.current) {
          setDraft(current.config);
          setVersion(current.version);
          loaded.current = true;
        }
      } catch (e) {
        if (active && alive.current && request === readVersion.current) setError(errorText(e));
      } finally {
        requestActive = false;
      }
    };
    void load(true);
    const timer = window.setInterval(() => void load(false), 2000);
    return () => {
      active = false;
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [desktop]);

  async function run(operation: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    readVersion.current += 1;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      working.current = false;
      if (alive.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  const add = (target: ProtectionTarget) => {
    const trimmed = { ...target, value: target.value.trim() };
    if (!trimmed.value || draft.applications.some((t) => identity(t) === identity(trimmed))) return;
    edited.current = true;
    setDraft({ ...draft, applications: [...draft.applications, trimmed] });
    setValue('');
  };
  const selected = new Set(draft.applications.map(identity));
  const choices =
    kind === 'package'
      ? (catalog?.packages ?? []).map((p) => ({
          value: p.family,
          label: `${p.name} · ${p.family}`,
        }))
      : [
          ...new Map(
            (catalog?.processes ?? [])
              .filter((p) => p.path)
              .map((p) => [
                p.path!.toLowerCase(),
                { value: p.path!, label: `${p.name} · ${p.path}` },
              ]),
          ).values(),
        ];
  return (
    <section className="app-protection-settings">
      <div className="capture-current" role="status">
        <strong>
          {!snapshot
            ? 'Loading app protection…'
            : snapshot.error
              ? 'App protection needs attention'
              : snapshot.blocked
                ? 'Applications blocked while routing recovers'
                : snapshot?.config.enabled
                  ? 'Restart protection enabled'
                  : 'Restart protection off'}
        </strong>
        <p className="field-help">
          Selected apps cannot connect directly during routing restarts or Wayrill updates. Stop
          releases them. Versioned installations follow app updates automatically.
        </p>
        {snapshot?.error && (
          <p role="alert" className="notice notice--error">
            {snapshot.error.message}
          </p>
        )}
      </div>
      {(error || catalogError) && (
        <p role="alert" className="notice notice--error">
          {error || catalogError}
        </p>
      )}
      <fieldset className="capture-settings-fields" disabled={!desktop || busy || !snapshot}>
        <label className="app-protection-switch">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => {
              edited.current = true;
              setDraft({ ...draft, enabled: e.target.checked });
            }}
          />{' '}
          Block direct access during restarts and updates
        </label>
        <div className="form-row app-protection-add">
          <select
            className="text-control"
            aria-label="Protected application type"
            disabled={listLocked}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setValue('');
            }}
          >
            <option value="executable">Executable</option>
            <option value="package">AppContainer package</option>
          </select>
          <input
            className="text-control"
            aria-label="Protected application"
            disabled={listLocked}
            value={value}
            placeholder={kind === 'executable' ? 'Full executable path' : 'Package family'}
            onChange={(e) => setValue(e.target.value)}
          />
          {kind === 'executable' && (
            <button
              className="small-action"
              title="Choose executable"
              aria-label="Choose protected executable"
              disabled={listLocked}
              onClick={() =>
                void run(async () => {
                  const path = await invoke<string | null>('process_picker', {
                    mode: 'path',
                  });
                  if (alive.current && path) setValue(path);
                })
              }
            >
              <FolderOpen size={15} />
            </button>
          )}
          <button
            className="small-action"
            title="Add application"
            aria-label="Add protected application"
            disabled={listLocked || !value.trim() || draft.applications.length >= 256}
            onClick={() => add({ kind, value })}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="form-row app-protection-catalog">
          <select
            className="text-control"
            aria-label="Choose protected application from this PC"
            disabled={listLocked || draft.applications.length >= 256}
            value=""
            onChange={(e) => {
              if (e.target.value) add({ kind, value: e.target.value });
            }}
          >
            <option value="">Choose from this PC…</option>
            {choices
              .filter((p) => !selected.has(identity({ kind, value: p.value })))
              .map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
          </select>
          <button
            className="small-action"
            aria-label="Refresh protected application choices"
            disabled={loading}
            onClick={refreshCatalog}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        <p className="field-help">
          Add separate helper and networking executables too. Child processes are not included
          automatically.
        </p>
        {kind === 'package' && (
          <p className="field-help">
            For packaged desktop apps that run outside AppContainer, select their executables
            instead.
          </p>
        )}
        <ul className="app-protection-list">
          {draft.applications.map((target) => (
            <li key={identity(target)}>
              <span title={target.value}>{target.value}</span>
              <button
                className="icon-button"
                aria-label={`Remove ${target.value}`}
                disabled={listLocked}
                onClick={() => {
                  edited.current = true;
                  setDraft({
                    ...draft,
                    applications: draft.applications.filter(
                      (t) => identity(t) !== identity(target),
                    ),
                  });
                }}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
        {snapshot && snapshot.version !== version && (
          <p role="alert">Settings changed elsewhere. Refresh before saving.</p>
        )}
        <div className="action-row capture-actions">
          <button
            className="primary-button"
            disabled={
              !version ||
              snapshot?.version !== version ||
              (listLocked && draft.enabled) ||
              (draft.enabled && !draft.applications.length)
            }
            onClick={() =>
              void run(async () => {
                const saved = await serviceCall<ProtectionSnapshot>('appProtection.set', {
                  expectedVersion: version,
                  config: draft,
                });
                if (alive.current) {
                  setSnapshot(saved);
                  setDraft(saved.config);
                  edited.current = false;
                  setVersion(saved.version);
                }
                await onRuntimeRefresh();
              })
            }
          >
            Save
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              void run(async () => {
                const current = await serviceCall<ProtectionSnapshot>('appProtection.get');
                if (alive.current) {
                  setSnapshot(current);
                  setDraft(current.config);
                  edited.current = false;
                  setVersion(current.version);
                }
              })
            }
          >
            Refresh
          </button>
        </div>
      </fieldset>
    </section>
  );
}

import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import useModalDialog from './useModalDialog';
import { useEffect, useRef, useState, useId } from 'react';
import { X, RefreshCw } from 'lucide-react';
import type { GraphState } from '../graph/types';
import { defaultCaptureOptions } from '../graph/capture';
import { desktopServiceAvailable, errorText, serviceCall } from '../serviceClient';
import { useWindowsCatalog } from './useWindowsCatalog';
interface LoopbackSnapshot {
  version: string;
  packages: {
    family: string;
    name: string;
    publisher: string;
    enabled: boolean;
  }[];
  unmatched: string[];
}
export default function WindowsCaptureSettings({
  graph,
  onApply,
  onClose,
  adaptersOnly = false,
  embedded = false,
  initialTab = 'interfaces',
  loopbackOnly = false,
  onMutationChange,
}: {
  adaptersOnly?: boolean;
  embedded?: boolean;
  initialTab?: 'interfaces' | 'loopback';
  loopbackOnly?: boolean;
  onMutationChange?: (changing: boolean) => void;
  graph: GraphState;
  onApply: (graph: GraphState) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [tab, setTab] = useState<'interfaces' | 'loopback'>(initialTab),
    [options, setOptions] = useState(() =>
      structuredClone(graph.captureOptions ?? defaultCaptureOptions()),
    );
  const { catalog, error: catalogError, loading, refresh } = useWindowsCatalog();
  const [permissions, setPermissions] = useState<LoopbackSnapshot | null>(null),
    [checked, setChecked] = useState<Record<string, boolean>>({}),
    [search, setSearch] = useState(''),
    [operation, setOperation] = useState<'load' | 'apply' | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const excluded = (id: string) =>
    catalog?.excludedCaptureInterfaces?.some(
      (owned) => owned.toLowerCase() === id.replace(/[{}]/g, '').toLowerCase(),
    ) ||
    catalog?.interfaces.some((a) => a.id === id && a.captureExcluded) ||
    false;
  const titleId = useId();
  const mounted = useRef(true);
  const busy = operation !== null;
  const changing = operation === 'apply';
  useModalDialog(dialog);
  const tabs = useEditorTabs(
    [
      ...(!loopbackOnly ? [{ key: 'interfaces' as const, label: 'Monitored interfaces' }] : []),
      ...(!adaptersOnly ? [{ key: 'loopback' as const, label: 'Loopback exemptions' }] : []),
    ],
    tab,
    setTab,
  );
  useEffect(() => {
    onMutationChange?.(changing);
    return () => onMutationChange?.(false);
  }, [changing, onMutationChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = async () => {
    setOperation('load');
    setError('');
    setNotice('');
    try {
      const value = await serviceCall<LoopbackSnapshot>('windows.loopback.get');
      if (mounted.current) {
        setPermissions(value);
        setChecked(Object.fromEntries(value.packages.map((p) => [p.family, p.enabled])));
      }
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setOperation(null);
    }
  };
  useEffect(() => {
    if (tab === 'loopback' && !permissions && desktopServiceAvailable()) void load();
  }, [tab, permissions]);
  useEffect(() => {
    if (catalog)
      setOptions((o) => {
        const known = new Set(o.interfaces.interfaces.map((i) => i.id.toLowerCase()));
        return {
          ...o,
          interfaces: {
            ...o.interfaces,
            interfaces: [
              ...o.interfaces.interfaces,
              ...(catalog.captureInterfaces ?? []).filter((a) => !known.has(a.id.toLowerCase())),
              ...catalog.interfaces
                .filter((a) => !known.has(a.id.toLowerCase()))
                .filter(
                  (a) =>
                    !catalog.captureInterfaces?.some(
                      (i) => i.id.toLowerCase() === a.id.toLowerCase(),
                    ),
                )
                .map((a) => ({
                  id: a.id,
                  name: a.name,
                  monitored: o.interfaces.monitorNewInterfaces,
                })),
            ],
          },
        };
      });
  }, [catalog]);
  const rows =
    permissions?.packages.filter((p) =>
      (p.name + ' ' + p.family + ' ' + p.publisher).toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const changes =
    permissions?.packages
      .filter((p) => checked[p.family] !== p.enabled)
      .map((p) => ({ family: p.family, enabled: checked[p.family] })) ?? [];
  const apply = async () => {
    if (!permissions || !changes.length) return;
    setOperation('apply');
    setError('');
    try {
      const value = await serviceCall<LoopbackSnapshot>('windows.loopback.set', {
        expectedVersion: permissions.version,
        changes,
      });
      if (mounted.current) {
        setPermissions(value);
        setChecked(Object.fromEntries(value.packages.map((p) => [p.family, p.enabled])));
        setNotice(`Updated ${changes.length} package permissions.`);
      }
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setOperation(null);
    }
  };
  return (
    <dialog
      ref={embedded ? null : dialog}
      open={embedded ? true : undefined}
      role={embedded ? 'group' : undefined}
      aria-label={
        embedded ? (loopbackOnly ? 'Loopback exemptions' : 'Monitored adapters') : undefined
      }
      className={
        (embedded
          ? 'windows-settings-embedded'
          : 'rule-editor-window capture-window windows-settings') +
        (tab === 'loopback' ? ' windows-loopback-settings' : '')
      }
      onClose={onClose}
      onCancel={(e) => {
        if (changing) e.preventDefault();
      }}
      aria-labelledby={embedded ? undefined : titleId}
    >
      {!embedded && (
        <div className="rule-editor-titlebar">
          <div>
            <h2 id={titleId}>
              {adaptersOnly ? 'Monitored adapters' : 'Windows capture & loopback'}
            </h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close Windows capture settings"
            onClick={onClose}
            disabled={changing}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {!adaptersOnly && !loopbackOnly && (
        <EditorTabs tabs={tabs} label="Windows capture sections" disabled={busy} />
      )}
      <EditorTabPanels tabs={tabs} className="windows-settings-body">
        {tab === 'interfaces' ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={options.interfaces.monitorNewInterfaces}
                onChange={(e) =>
                  setOptions((o) => ({
                    ...o,
                    interfaces: {
                      ...o.interfaces,
                      monitorNewInterfaces: e.target.checked,
                    },
                  }))
                }
              />{' '}
              Monitor new interfaces
            </label>
            <label>
              <input
                type="checkbox"
                checked={options.bypassLocalTraffic}
                onChange={(e) =>
                  setOptions((o) => ({
                    ...o,
                    bypassLocalTraffic: e.target.checked,
                  }))
                }
              />{' '}
              Keep discovery, DHCP, multicast and link-local traffic on its original link
            </label>
            <p className="field-help">
              New adapters use “Monitor new interfaces”. Apply to the graph, then Apply to update
              capture.
            </p>

            {catalogError && (
              <p role="alert" className="notice notice--error">
                {catalogError}
              </p>
            )}
            <div className="form-row capture-picker-header">
              <button
                className="secondary-button"
                disabled={loading || !desktopServiceAvailable()}
                onClick={refresh}
              >
                <RefreshCw size={14} /> Refresh adapters
              </button>
              <button
                className="secondary-button"
                disabled={!catalog?.interfaces.length}
                onClick={() =>
                  setOptions((o) => ({
                    ...o,
                    interfaces: {
                      monitorNewInterfaces: false,
                      interfaces: (catalog?.interfaces ?? []).map((a) => ({
                        id: a.id,
                        name: a.name,
                        monitored:
                          !excluded(a.id) && a.status === 1 && (a.addresses?.length ?? 0) > 0,
                      })),
                    },
                  }))
                }
              >
                Select active adapters
              </button>
              <button
                className="secondary-button"
                disabled={!catalog?.interfaces.length}
                onClick={() =>
                  setOptions((o) => ({
                    ...o,
                    interfaces: {
                      monitorNewInterfaces: false,
                      interfaces: (catalog?.interfaces ?? []).map((a) => ({
                        id: a.id,
                        name: a.name,
                        monitored: false,
                      })),
                    },
                  }))
                }
              >
                Clear selection
              </button>
            </div>
            <div className="capture-picker-list capture-system-list">
              {catalog?.interfaces.map((a) => {
                const saved = options.interfaces.interfaces.find(
                  (i) => i.id.toLowerCase() === a.id.toLowerCase(),
                );
                return (
                  <label key={a.id}>
                    <input
                      type="checkbox"
                      disabled={excluded(a.id)}
                      checked={
                        !excluded(a.id) &&
                        (saved?.monitored ?? options.interfaces.monitorNewInterfaces)
                      }
                      onChange={(e) =>
                        setOptions((o) => ({
                          ...o,
                          interfaces: {
                            ...o.interfaces,
                            interfaces: [
                              ...o.interfaces.interfaces.filter(
                                (i) => i.id.toLowerCase() !== a.id.toLowerCase(),
                              ),
                              {
                                id: a.id,
                                name: a.name,
                                monitored: e.target.checked,
                              },
                            ],
                          },
                        }))
                      }
                    />
                    <span className="capture-system-row">
                      <strong>{a.name}</strong>
                      <small title={a.description}>
                        {excluded(a.id)
                          ? 'Wayrill TUN · excluded from capture'
                          : a.status === 1
                            ? 'Up'
                            : 'Inactive'}{' '}
                        ·{' '}
                        {(a.addresses ?? [])
                          .map((ip) => `${ip.address}/${ip.prefixLength}`)
                          .join(', ') || 'No assigned addresses'}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
            {!desktopServiceAvailable() && (
              <p className="field-help">
                The Windows desktop app can list this computer’s adapters.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="field-help">
              Loopback permissions are system-wide and remain after Wayrill stops. Apply permissions
              changes the selected packages; unmatched exemptions are preserved.
            </p>
            <input
              className="text-control capture-package-search"
              aria-label="Search loopback packages"
              placeholder="Search Windows apps"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="form-row capture-picker-header">
              <button
                className="secondary-button"
                disabled={busy || !desktopServiceAvailable()}
                onClick={() => void load()}
              >
                <RefreshCw size={13} /> Refresh
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  setChecked((c) => ({
                    ...c,
                    ...Object.fromEntries(rows.map((p) => [p.family, true])),
                  }))
                }
              >
                Enable visible
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  setChecked((c) => ({
                    ...c,
                    ...Object.fromEntries(rows.map((p) => [p.family, false])),
                  }))
                }
              >
                Disable visible
              </button>
              <button
                className="primary-button"
                disabled={busy || !changes.length}
                onClick={() => void apply()}
              >
                {busy
                  ? operation === 'apply'
                    ? 'Applying…'
                    : 'Loading…'
                  : `Apply permissions${changes.length ? ` (${changes.length})` : ''}`}
              </button>
            </div>
            <div
              className="capture-picker-list capture-system-list"
              role="region"
              aria-label="Windows app loopback permissions"
              tabIndex={0}
            >
              {rows.map((p) => (
                <label key={p.family}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={checked[p.family] ?? p.enabled}
                    onChange={(e) =>
                      setChecked((c) => ({
                        ...c,
                        [p.family]: e.target.checked,
                      }))
                    }
                  />
                  <span className="capture-system-row">
                    <strong>{p.name}</strong>
                    <small title={p.family}>{p.family}</small>
                  </span>
                </label>
              ))}
            </div>
            <p className="field-help">
              {permissions
                ? `${permissions.packages.length} installed packages · ${permissions.unmatched.length} unmatched exemptions · ${changes.length} pending changes`
                : busy
                  ? 'Loading permissions…'
                  : 'Available in the Windows desktop app.'}
            </p>
            {notice && <p role="status">{notice}</p>}
          </>
        )}
      </EditorTabPanels>
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {(tab === 'interfaces' || !embedded) && (
        <div className="rule-editor-footer">
          {!embedded && (
            <button className="secondary-button" disabled={changing} onClick={onClose}>
              {tab === 'interfaces' ? 'Cancel' : 'Close'}
            </button>
          )}
          {tab === 'interfaces' && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                const current = catalog?.interfaces ?? [];
                const known = new Set(options.interfaces.interfaces.map((i) => i.id.toLowerCase()));
                const captureOptions = {
                  ...options,
                  interfaces: {
                    ...options.interfaces,
                    interfaces: [
                      ...options.interfaces.interfaces,
                      ...current
                        .filter((a) => !known.has(a.id.toLowerCase()))
                        .map((a) => ({
                          id: a.id,
                          name: a.name,
                          monitored: options.interfaces.monitorNewInterfaces,
                        })),
                    ],
                  },
                };
                captureOptions.interfaces.interfaces = captureOptions.interfaces.interfaces.map(
                  (a) => (excluded(a.id) ? { ...a, monitored: false } : a),
                );
                try {
                  onApply({ ...graph, captureOptions });
                  if (!embedded) onClose();
                } catch (error) {
                  setError(errorText(error));
                }
              }}
            >
              Apply to graph
            </button>
          )}
        </div>
      )}
    </dialog>
  );
}

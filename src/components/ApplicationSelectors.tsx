import { invoke } from '@tauri-apps/api/core';
import { useState, useRef, useEffect } from 'react';
import { Plus, RefreshCw, Trash2, FolderOpen } from 'lucide-react';
import { type ApplicationSelector } from '../graph/applications';
import { useWindowsCatalog } from './useWindowsCatalog';
import { desktopServiceAvailable, errorText, serviceCall } from '../serviceClient';
import { applicationChoices } from './applicationChoices';
export default function ApplicationSelectors({
  rows,
  onChange,
}: {
  rows: ApplicationSelector[];
  onChange: (rows: ApplicationSelector[]) => void;
}) {
  const latest = useRef({ rows, onChange });
  latest.current = { rows, onChange };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [loopbackBusy, setLoopbackBusy] = useState(false),
    [bulkError, setBulkError] = useState('');
  const [packageNames, setPackageNames] = useState<Record<string, string>>({});
  const { catalog, error, loading, refresh } = useWindowsCatalog();
  const [kind, setKind] = useState<ApplicationSelector['kind']>('process');
  const [mode, setMode] = useState<ApplicationSelector['mode']>('name');
  const [children, setChildren] = useState(false),
    [value, setValue] = useState(''),
    [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [picking, setPicking] = useState(false),
    [pickerError, setPickerError] = useState('');
  async function browse() {
    setPicking(true);
    setPickerError('');
    try {
      const choice = await invoke<string | null>('process_picker', { mode });
      if (choice !== null) setValue(choice);
    } catch (e) {
      setPickerError(errorText(e));
    } finally {
      setPicking(false);
    }
  }
  const filtered = applicationChoices(catalog, rows, kind, mode).filter((p) =>
    `${p.name} ${p.detail} ${p.value}`.toLowerCase().includes(search.toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const add = (values: string[]) => {
    const additions = values
      .map((v) => v.trim())
      .filter(Boolean)
      .filter(
        (v) =>
          !rows.some(
            (r) =>
              r.kind === kind &&
              r.mode === (kind === 'process' ? mode : 'name') &&
              r.children === (kind !== 'service' && children) &&
              r.value.toLowerCase() === v.toLowerCase(),
          ),
      );
    if (rows.length + additions.length > 4096) {
      setBulkError('Choose at most 4,096 application selectors.');
      return;
    }
    setBulkError('');
    onChange([
      ...rows,
      ...additions.map((v) => ({
        kind,
        value: v,
        mode: kind === 'process' ? mode : ('name' as const),
        children: kind !== 'service' && children,
        enabled: true,
      })),
    ]);
    setValue('');
  };
  async function addExemptPackages() {
    setLoopbackBusy(true);
    setBulkError('');
    try {
      const snapshot = await serviceCall<{
        packages: { family: string; name: string; enabled: boolean }[];
      }>('windows.loopback.get');
      if (!mounted.current) return;
      setPackageNames(
        Object.fromEntries(snapshot.packages.map((p) => [p.family.toLowerCase(), p.name])),
      );
      const current = latest.current.rows;
      const selected = new Set(
        current.filter((r) => r.kind === 'package').map((r) => r.value.toLowerCase()),
      );
      const additions = snapshot.packages
        .filter((p) => p.enabled && !selected.has(p.family.toLowerCase()))
        .map((p) => ({
          kind: 'package' as const,
          value: p.family,
          mode: 'name' as const,
          children: false,
          enabled: true,
        }));
      if (current.length + additions.length > 4096) {
        setBulkError('Choose at most 4,096 application selectors.');
        return;
      }
      const enabled = new Set(
        snapshot.packages.filter((p) => p.enabled).map((p) => p.family.toLowerCase()),
      );
      latest.current.onChange([
        ...current.map((r) =>
          r.kind === 'package' && enabled.has(r.value.toLowerCase()) ? { ...r, enabled: true } : r,
        ),
        ...additions,
      ]);
    } catch (e) {
      if (mounted.current) setBulkError(errorText(e));
    } finally {
      if (mounted.current) setLoopbackBusy(false);
    }
  }
  const nameFor = (r: ApplicationSelector) =>
    r.kind === 'package'
      ? catalog?.packages.find((p) => p.family.toLowerCase() === r.value.toLowerCase())?.name ||
        packageNames[r.value.toLowerCase()]
      : r.kind === 'service'
        ? catalog?.services.find((p) => p.name.toLowerCase() === r.value.toLowerCase())?.displayName
        : undefined;
  return (
    <fieldset className="editor-panel application-selectors" data-diagnostic-field="applications">
      <legend>Processes, Windows apps & services</legend>
      <p className="field-help">
        Local inputs match process names and paths. TUN and WinDivert also match child processes,
        Windows apps and services.
      </p>
      <div className="form-row capture-picker-header">
        <select
          className="text-control"
          aria-label="Application type"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setPage(0);
          }}
        >
          <option value="process">Process</option>
          <option value="package">Windows app</option>
          <option value="service">Windows service</option>
        </select>
        {kind === 'process' && (
          <select
            className="text-control"
            aria-label="Process match"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              setPage(0);
            }}
          >
            <option value="name">Executable name</option>
            <option value="path">Full executable path</option>
            <option value="folder">Folder</option>
          </select>
        )}
        {kind !== 'service' && (
          <label className="check-control">
            <input
              autoComplete="off"
              type="checkbox"
              checked={children}
              onChange={(e) => setChildren(e.target.checked)}
            />{' '}
            Include child processes
          </label>
        )}
        <button
          className="small-action"
          disabled={loading || !desktopServiceAvailable()}
          onClick={refresh}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      {(error || pickerError || bulkError) && (
        <p role="alert">{bulkError || pickerError || error}</p>
      )}
      {kind === 'package' && (
        <div className="form-row capture-picker-header">
          <button
            className="small-action"
            disabled={loopbackBusy || !desktopServiceAvailable()}
            onClick={() => void addExemptPackages()}
          >
            Add loopback-exempt apps
          </button>
        </div>
      )}
      <div className="form-row capture-picker-header">
        <input
          className="text-control"
          autoComplete="off"
          aria-label="Application selector"
          placeholder={
            kind === 'process'
              ? mode === 'name'
                ? 'example.exe'
                : 'Absolute path'
              : kind === 'package'
                ? 'Package family'
                : 'Service name'
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {kind === 'process' && (
          <button
            className="small-action"
            disabled={picking || !desktopServiceAvailable()}
            onClick={() => void browse()}
            title={
              desktopServiceAvailable()
                ? 'Select an executable or folder'
                : 'Available in the Windows desktop app'
            }
          >
            <FolderOpen size={13} /> Browse…
          </button>
        )}
        <button
          className="small-action"
          disabled={!value.trim() || rows.length >= 4096}
          onClick={() => add([value])}
        >
          <Plus size={13} /> Add
        </button>
      </div>
      <details>
        <summary>Choose from this PC</summary>
        <input
          className="text-control"
          autoComplete="off"
          aria-label="Search applications"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search"
        />
        <div className="form-row capture-picker-header">
          <button
            className="small-action"
            disabled={!filtered.length && !rows.some((r) => r.kind === kind && !r.enabled)}
            onClick={() => {
              const values = [...new Set(filtered.map((p) => p.value))];
              const additions = values.filter(
                (v) =>
                  !rows.some((r) => r.kind === kind && r.value.toLowerCase() === v.toLowerCase()),
              );
              if (rows.length + additions.length > 4096) {
                setBulkError('Choose at most 4,096 application selectors.');
                return;
              }
              setBulkError('');
              onChange([
                ...rows.map((r) => (r.kind === kind ? { ...r, enabled: true } : r)),
                ...additions.map((v) => ({
                  kind,
                  value: v,
                  mode: kind === 'process' ? mode : ('name' as const),
                  children: kind !== 'service' && children,
                  enabled: true,
                })),
              ]);
            }}
          >
            Select all
          </button>
          <button
            className="small-action"
            disabled={!rows.some((r) => r.kind === kind && r.enabled)}
            onClick={() =>
              onChange(rows.map((r) => (r.kind === kind ? { ...r, enabled: false } : r)))
            }
          >
            Select none
          </button>
        </div>
        <div className="choice-list capture-picker-list">
          {filtered.slice(currentPage * 50, currentPage * 50 + 50).map((p) => (
            <label
              key={`${p.name}|${p.detail}`}
              className="check-control choice-row choice-row--compact application-choice"
              title={`${p.name} · ${p.detail}`}
            >
              <input
                autoComplete="off"
                type="checkbox"
                checked={false}
                onChange={() => add([p.value])}
              />
              <span className="item-content item-content--inline">
                <strong>{p.name}</strong>
                {p.detail.toLowerCase() !== p.name.toLowerCase() && <small>{p.detail}</small>}
              </span>
            </label>
          ))}
        </div>
        <div className="form-row capture-picker-header">
          <button
            className="secondary-button"
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span>{filtered.length} available</span>
          <button
            className="secondary-button"
            disabled={(currentPage + 1) * 50 >= filtered.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      </details>
      <div className="capture-selector-list">
        {rows.map((r, i) => (
          <div key={i} className="application-selector-row">
            <input
              autoComplete="off"
              type="checkbox"
              aria-label={`Enable ${r.value}`}
              checked={r.enabled}
              onChange={(e) =>
                onChange(rows.map((v, j) => (j === i ? { ...v, enabled: e.target.checked } : v)))
              }
            />
            <span className="item-content" title={r.value}>
              {nameFor(r) ? (
                <>
                  <strong>{nameFor(r)}</strong>
                  <small>{r.value}</small>
                </>
              ) : (
                <>
                  {r.kind} · {r.value}
                </>
              )}
            </span>
            {r.kind !== 'service' && (
              <label className="check-control check-control--compact">
                <input
                  autoComplete="off"
                  type="checkbox"
                  aria-label={`Children of ${r.value}`}
                  checked={r.children}
                  onChange={(e) =>
                    onChange(
                      rows.map((v, j) => (j === i ? { ...v, children: e.target.checked } : v)),
                    )
                  }
                />{' '}
                Children
              </label>
            )}
            <button
              className="icon-button"
              aria-label={`Remove ${r.value}`}
              onClick={() => onChange(rows.filter((_, j) => i !== j))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { exportFile } from '../exportFile';
import { errorText, serviceCall } from '../serviceClient';
import { applicationChoices } from '../components/applicationChoices';
import { useWindowsCatalog } from '../components/useWindowsCatalog';
import {
  readApplicationIdentity,
  readPoolApplication,
  readPoolExecutable,
  writeApplicationIdentity,
  type PoolApplicationBinding,
  type PoolApplicationChanges,
  type PoolApplicationDetection,
  type PoolApplicationIdentity,
  type PoolApplicationSelector,
  type PoolExecutable,
} from '../graph/applications';

export function exportApplicationIdentity(identity: PoolApplicationIdentity) {
  return exportFile('wayrill-app-identity.json', writeApplicationIdentity(identity));
}

export function PoolApplicationPicker({
  rows,
  known,
  onChange,
}: {
  rows: PoolApplicationSelector[];
  known: PoolApplicationIdentity[];
  onChange: (rows: PoolApplicationSelector[]) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [match, setMatch] = useState<'automatic' | 'subscriber' | 'identity'>('automatic');
  const [executable, setExecutable] = useState<PoolExecutable>({ name: '' });
  const [describing, setDescribing] = useState(false);
  const [packages, setPackages] = useState('');
  const [services, setServices] = useState('');
  const [requireLocal, setRequireLocal] = useState(false);
  const [failure, setFailure] = useState('');
  const { available, catalog, loading, error, refresh } = useWindowsCatalog(
    creating && match !== 'subscriber',
  );
  const identityKinds = ['package', 'service'] as const;
  const used = new Set(rows.map(({ identity }) => identity.id));
  const choices = known.filter(({ id }) => !used.has(id));

  function add(identity: PoolApplicationIdentity) {
    const previous = known.find(({ id }) => id === identity.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(identity))
      throw new Error('That identity ID already has a different definition in this filter.');
    if (!used.has(identity.id))
      onChange([...rows, { kind: 'pool', identity, enabled: true, children: false }]);
    setFailure('');
  }

  function create() {
    try {
      const entries = (text: string, kind: 'package' | 'service') =>
        [
          ...new Map(
            text.split(/\r?\n/).map((line) => {
              const value = line.trim();
              return [value.toLowerCase(), value];
            }),
          ).values(),
        ]
          .filter(Boolean)
          .map((value) => ({ kind, value }));
      const identities =
        match === 'identity'
          ? [...entries(packages, 'package'), ...entries(services, 'service')]
          : [];
      if (match === 'identity' && !identities.length)
        throw new Error('Add a package family name or a service name.');
      add(
        readPoolApplication({
          id: crypto.randomUUID(),
          name,
          identities,
          ...(match === 'automatic' && {
            executable: { ...executable, name: executable.name.trim() },
          }),
          ...(match !== 'identity' && requireLocal ? { requireLocal: true } : {}),
        }),
      );
      setCreating(false);
      setName('');
      setMatch('automatic');
      setExecutable({ name: '' });
      setPackages('');
      setServices('');
      setRequireLocal(false);
    } catch (error) {
      setFailure(errorText(error));
    }
  }

  async function describe(path?: string) {
    setDescribing(true);
    setFailure('');
    try {
      const selected = path ?? (await invoke<string | null>('process_picker', { mode: 'path' }));
      if (!selected) return;
      const label = selected.split(/[\\/]/).at(-1) ?? '';
      setExecutable({ name: label });
      setName((current) => current || label.replace(/\.exe$/i, ''));
      const descriptor =
        document.documentElement.dataset.app === 'pool'
          ? await invoke<unknown>('pool_describe_executable', { path: selected })
          : await serviceCall<unknown>('windows.describeExecutable', { path: selected });
      setExecutable(readPoolExecutable(descriptor));
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setDescribing(false);
    }
  }

  return (
    <div className="editor-stack">
      <div className="editor-section-heading">Pool applications</div>
      <div className="pool-dialog-actions">
        {choices.length > 0 && (
          <select
            aria-label="Add an existing application"
            value=""
            onChange={(event) => {
              const choice = choices.find(({ id }) => id === event.currentTarget.value);
              if (choice) add(choice);
            }}
          >
            <option value="" disabled>
              Add an existing application…
            </option>
            {choices.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={describing}
          onClick={() => {
            setCreating(!creating);
            setFailure('');
          }}
        >
          {creating ? 'Cancel new application' : 'New application…'}
        </button>
        <button type="button" className="secondary-button" onClick={() => file.current?.click()}>
          Import identity…
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const picked = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (picked)
              void (
                picked.size > 65536
                  ? Promise.reject(new Error('Application identity files must be under 64 KiB.'))
                  : picked.text().then((text) => add(readApplicationIdentity(text)))
              ).catch((error) => setFailure(errorText(error)));
          }}
        />
      </div>
      {creating && (
        <fieldset className="editor-panel editor-stack" disabled={describing}>
          <legend>New Pool application</legend>
          <label className="editor-field">
            <span>Name shown to subscribers</span>
            <input
              value={name}
              maxLength={128}
              placeholder="e.g. Calculator"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="editor-field">
            <span>How to match on the subscriber’s PC</span>
            <select
              value={match}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setMatch(value === 'identity' || value === 'subscriber' ? value : 'automatic');
                setFailure('');
              }}
            >
              <option value="automatic">Find the executable on each PC</option>
              <option value="subscriber">Let each subscriber choose</option>
              <option value="identity">Match a Windows package or service</option>
            </select>
          </label>
          {match === 'automatic' && (
            <>
              <label className="editor-field">
                <span>Executable filename</span>
                <input
                  value={executable.name}
                  placeholder="Example.exe"
                  onChange={(event) => setExecutable({ name: event.currentTarget.value })}
                />
              </label>
              {available && (
                <div className="pool-dialog-actions">
                  {catalog && (
                    <select
                      aria-label="Choose a running executable"
                      value=""
                      onChange={(event) => {
                        if (event.currentTarget.value) void describe(event.currentTarget.value);
                      }}
                    >
                      <option value="">Choose a running executable…</option>
                      {[
                        ...new Map(
                          applicationChoices(catalog, [], 'process', 'path').map((choice) => [
                            choice.value.toLowerCase(),
                            choice,
                          ]),
                        ).values(),
                      ].map(({ name, value }) => (
                        <option key={value} value={value}>
                          {name} · {value}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void describe()}
                  >
                    Browse for executable…
                  </button>
                </div>
              )}
              <p className="field-help">
                Choose a file to identify its product and publisher, or enter its filename. The
                publisher’s full path stays on this PC.
              </p>
            </>
          )}
          {match === 'subscriber' && (
            <p className="field-help">
              Subscribers select the actual app under Applications on this PC.
            </p>
          )}
          {match !== 'identity' ? (
            <>
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={requireLocal}
                  onChange={(event) => setRequireLocal(event.currentTarget.checked)}
                />
                Require a match before subscribers can apply the graph
              </label>
            </>
          ) : (
            <>
              <p className="field-help">
                Any listed identity matches. Use one identity per line for alternate editions. If
                the app is on another PC, you can also export its identity there and import it here.
              </p>
              {identityKinds.map((kind) => {
                const isPackage = kind === 'package';
                const value = isPackage ? packages : services;
                const setValue = isPackage ? setPackages : setServices;
                const added = new Set(
                  value
                    .toLowerCase()
                    .split(/\r?\n/)
                    .map((line) => line.trim()),
                );
                const installed = applicationChoices(catalog, [], kind, 'name').filter(
                  (item) => !added.has(item.value.toLowerCase()),
                );
                return (
                  <div className="editor-stack" key={kind}>
                    <label className="editor-field">
                      <span>{isPackage ? 'Package family names' : 'Windows service names'}</span>
                      <textarea
                        value={value}
                        rows={2}
                        placeholder={
                          isPackage ? 'Microsoft.WindowsCalculator_8wekyb3d8bbwe' : 'Dnscache'
                        }
                        onChange={(event) => setValue(event.currentTarget.value)}
                      />
                      <small className="field-help">
                        {isPackage
                          ? 'Use the package family name, such as the one shown after the app in the picker.'
                          : 'Use the Service name from Windows Services → Properties.'}
                      </small>
                    </label>
                    {!!installed.length && (
                      <select
                        aria-label={
                          isPackage ? 'Add a package from this PC' : 'Add a service from this PC'
                        }
                        value=""
                        onChange={(event) => {
                          const choice = installed.find(
                            ({ value }) => value === event.currentTarget.value,
                          );
                          if (!choice) return;
                          setValue([value.trim(), choice.value].filter(Boolean).join('\n'));
                          if (!name.trim()) setName(choice.name.slice(0, 128));
                        }}
                      >
                        <option value="">
                          {isPackage
                            ? 'Add a package from this PC…'
                            : 'Add a service from this PC…'}
                        </option>
                        {installed.map(({ name, value }) => (
                          <option key={value} value={value}>
                            {name} · {value}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
              {available && (loading || error) && (
                <div>
                  <p className="field-help" role="status">
                    {loading
                      ? 'Reading installed apps and services…'
                      : 'Couldn’t read this PC. You can still enter an identity manually.'}
                  </p>
                  {error && (
                    <button type="button" className="secondary-button" onClick={refresh}>
                      Retry
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={
              !name.trim() ||
              (match === 'automatic' && !executable.name.trim()) ||
              (match === 'identity' && !packages.trim() && !services.trim())
            }
            onClick={create}
          >
            Add application
          </button>
        </fieldset>
      )}
      <ul className="pool-route-summary">
        {rows.map((row) => (
          <li key={row.identity.id}>
            <strong>{row.identity.name}</strong>
            <span>
              {row.identity.executable?.name ||
                row.identity.identities.map(({ value }) => value).join(', ') ||
                (row.identity.requireLocal ? 'Local choice required' : 'Choose on each PC')}
            </span>
            {(!row.identity.identities.length ||
              row.identity.identities.some(({ kind }) => kind === 'package')) && (
              <label>
                <input
                  type="checkbox"
                  checked={row.children}
                  onChange={(event) => {
                    const children = event.currentTarget.checked;
                    onChange(rows.map((item) => (item === row ? { ...item, children } : item)));
                  }}
                />
                Include child processes
              </label>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void exportApplicationIdentity(row.identity).catch((error) =>
                  setFailure(errorText(error)),
                );
              }}
            >
              Export identity…
            </button>
            <button
              type="button"
              className="secondary-button"
              aria-label={`Remove ${row.identity.name}`}
              onClick={() => onChange(rows.filter((item) => item !== row))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {failure && (
        <p role="alert" className="notice notice--error">
          {failure}
        </p>
      )}
    </div>
  );
}

type BoundApplication = PoolApplicationIdentity & {
  binding?: PoolApplicationBinding;
  detection?: PoolApplicationDetection[string];
};

export function PoolApplicationBindingEditor({
  applications,
  changes,
  onChange,
}: {
  applications: BoundApplication[];
  changes: PoolApplicationChanges;
  onChange: (id: string, binding: PoolApplicationBinding | null) => void;
}) {
  const { catalog, error, loading, refresh } = useWindowsCatalog();
  const [editing, setEditing] = useState<string>();
  const [kind, setKind] = useState<PoolApplicationBinding['kind']>('process');
  const [query, setQuery] = useState('');
  const [failure, setFailure] = useState('');
  const choices = editing
    ? applicationChoices(catalog, [], kind, 'path').filter(({ name, detail }) =>
        `${name} ${detail}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];

  function bind(choice: BoundApplication, value: string) {
    if (!value) return;
    onChange(choice.id, { kind, value });
    setEditing(undefined);
  }

  return (
    <details
      className="editor-advanced"
      open={
        applications.some(
          ({ identities, binding, detection, id }) =>
            !identities.length &&
            !detection?.path &&
            !(Object.hasOwn(changes, id) ? changes[id] : binding),
        ) || undefined
      }
    >
      <summary>Applications on this PC ({applications.length})</summary>
      <p className="field-help">
        Local choices are remembered for this Pool. Packages, services and child matching require
        TUN or WinDivert. An app without an identity or local choice leaves its application
        condition inactive.
      </p>
      <ul className="pool-route-summary">
        {applications.map((app) => {
          const binding = Object.hasOwn(changes, app.id) ? changes[app.id] : app.binding;
          const installed =
            catalog &&
            app.identities.some(({ kind, value }) =>
              kind === 'package'
                ? catalog.packages.some((item) => item.family.toLowerCase() === value.toLowerCase())
                : catalog.services.some((item) => item.name.toLowerCase() === value.toLowerCase()),
            );
          return (
            <li key={app.id}>
              <strong>{app.name}</strong>
              <span>
                {binding?.value ||
                  (app.detection?.path
                    ? `Found automatically · ${app.detection.path}`
                    : app.executable
                      ? app.detection?.candidates.length
                        ? 'Review possible matches'
                        : 'Executable not found'
                      : app.identities.length
                        ? catalog
                          ? installed
                            ? 'Found on this PC'
                            : 'Not installed on this PC'
                          : 'Uses published identities'
                        : app.requireLocal
                          ? 'Local choice required'
                          : 'No local app selected')}
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setEditing(editing === app.id ? undefined : app.id);
                  setKind(binding?.kind ?? (app.identities[0]?.kind || 'process'));
                  setQuery('');
                  setFailure('');
                }}
              >
                {binding || app.detection?.path ? 'Change local app…' : 'Choose on this PC…'}
              </button>
              {binding && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    onChange(app.id, null);
                    setEditing(undefined);
                  }}
                >
                  {app.executable ? 'Use automatic matching' : 'Clear local choice'}
                </button>
              )}
              {editing === app.id && (
                <div className="editor-stack">
                  <label className="editor-field">
                    <span>Type</span>
                    <select
                      value={kind}
                      onChange={(event) => {
                        const type = event.currentTarget.value;
                        if (type === 'process' || type === 'package' || type === 'service')
                          setKind(type);
                        setQuery('');
                      }}
                    >
                      <option value="process">Executable</option>
                      <option value="package">Windows package</option>
                      <option value="service">Windows service</option>
                    </select>
                  </label>
                  <label className="editor-field">
                    <span>Find on this PC</span>
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.currentTarget.value)}
                    />
                  </label>
                  <label className="editor-field">
                    <span>Matching apps</span>
                    <select value="" onChange={(event) => bind(app, event.currentTarget.value)}>
                      <option value="">
                        {loading ? 'Loading…' : choices.length ? 'Choose an app…' : 'No matches'}
                      </option>
                      {choices.slice(0, 100).map(({ value, name, detail }, index) => (
                        <option key={index} value={value}>
                          {name} · {detail}
                        </option>
                      ))}
                    </select>
                    {choices.length > 100 && <small>Search to narrow the list.</small>}
                  </label>
                  {kind === 'process' && !!app.detection?.candidates.length && (
                    <label className="editor-field">
                      <span>Possible matches</span>
                      <select value="" onChange={(event) => bind(app, event.currentTarget.value)}>
                        <option value="">Choose an executable…</option>
                        {app.detection.candidates.map((path) => (
                          <option key={path}>{path}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="pool-dialog-actions">
                    {kind === 'process' && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          void invoke<string | null>('process_picker', { mode: 'path' })
                            .then((path) => {
                              if (path) bind(app, path);
                            })
                            .catch((problem) => setFailure(errorText(problem)));
                        }}
                      >
                        Browse for executable…
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={loading}
                      onClick={refresh}
                    >
                      Refresh apps
                    </button>
                  </div>
                  {(failure || error) && (
                    <p role="alert" className="notice notice--error">
                      {failure || error}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

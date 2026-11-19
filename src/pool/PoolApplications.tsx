import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { exportFile } from '../exportFile';
import { errorText } from '../serviceClient';
import { applicationChoices } from '../components/applicationChoices';
import { useWindowsCatalog } from '../components/useWindowsCatalog';
import {
  readApplicationIdentity,
  readPoolApplication,
  writeApplicationIdentity,
  type PoolApplicationBinding,
  type PoolApplicationChanges,
  type PoolApplicationIdentity,
  type PoolApplicationSelector,
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
  const [packages, setPackages] = useState('');
  const [services, setServices] = useState('');
  const [requireLocal, setRequireLocal] = useState(false);
  const [failure, setFailure] = useState('');
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
        text
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => ({ kind, value }));
      add(
        readPoolApplication({
          id: crypto.randomUUID(),
          name,
          identities: [...entries(packages, 'package'), ...entries(services, 'service')],
          ...(!packages.trim() && !services.trim() && requireLocal ? { requireLocal: true } : {}),
        }),
      );
      setCreating(false);
      setName('');
      setPackages('');
      setServices('');
      setRequireLocal(false);
    } catch (error) {
      setFailure(errorText(error));
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
        <button type="button" className="secondary-button" onClick={() => setCreating(!creating)}>
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
        <fieldset>
          <legend>New Pool application</legend>
          <label className="editor-field">
            <span>Name</span>
            <input
              value={name}
              maxLength={128}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="editor-field">
            <span>Windows package family names</span>
            <textarea
              value={packages}
              rows={2}
              onChange={(event) => setPackages(event.currentTarget.value)}
            />
          </label>
          <label className="editor-field">
            <span>Internal Windows service names</span>
            <textarea
              value={services}
              rows={2}
              onChange={(event) => setServices(event.currentTarget.value)}
            />
          </label>
          <p className="field-help">
            Enter one identity per line. Leave both fields blank to let each subscriber choose their
            app.
          </p>
          {!packages.trim() && !services.trim() && (
            <label className="check-control">
              <input
                type="checkbox"
                checked={requireLocal}
                onChange={(event) => setRequireLocal(event.currentTarget.checked)}
              />
              Require a local choice before applying
            </label>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={!name.trim()}
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
              {row.identity.identities.map(({ value }) => value).join(', ') ||
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

type BoundApplication = PoolApplicationIdentity & { binding?: PoolApplicationBinding };

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
          ({ identities, binding, id }) =>
            !identities.length && !(Object.hasOwn(changes, id) ? changes[id] : binding),
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
                  (app.identities.length
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
                {binding ? 'Change local app…' : 'Choose on this PC…'}
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
                  Clear local choice
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
                  <div className="pool-dialog-actions">
                    {kind === 'process' && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          void invoke<string | null>('process_picker', { mode: 'path' })
                            .then((path) => {
                              if (path) onChange(app.id, { kind: 'process', value: path });
                            })
                            .then(() => setEditing(undefined))
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

import { useDeferredValue, useMemo, useState } from 'react';
import Dialog from '../components/Dialog';
import ResultPager from '../components/ResultPager';
import { stashRows } from '../profiles/stashModel';
import {
  entryCredentials,
  type CredentialField,
  type StashCredentialEdit,
} from '../profiles/stashCredentials';
import type { Stash } from '../profiles/import';
import { errorText } from '../serviceClient';

export default function PoolStashCredentials({
  stash,
  onSave,
  onClose,
}: {
  stash: Stash;
  onSave: (edits: StashCredentialEdit[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [show, setShow] = useState(false);
  const [edits, setEdits] = useState(new Map<string, CredentialField[]>());
  const [error, setError] = useState('');
  const rows = useMemo(
    () =>
      stashRows(stash).flatMap((row) => {
        if (!row.entry.profile) return [];
        try {
          const { fields } = entryCredentials(row.entry);
          return fields.length ? [{ ...row, key: JSON.stringify(row.link), fields }] : [];
        } catch {
          return [];
        }
      }),
    [stash],
  );
  const term = useDeferredValue(query.trim().toLowerCase());
  const matches = useMemo(
    () =>
      rows.filter(({ entry, group }) =>
        [entry.name, entry.address, entry.protocol, group.name]
          .join(' ')
          .toLowerCase()
          .includes(term),
      ),
    [rows, term],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / 40) - 1));
  return (
    <Dialog
      title="Edit server credentials"
      className="pool-dialog pool-stash-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="field-help">{edits.size} changed</span>
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!edits.size}
            onClick={() => {
              try {
                onSave(
                  rows.flatMap((row) => {
                    const fields = edits.get(row.key);
                    return fields ? [{ entry: row.entry, link: row.link, fields }] : [];
                  }),
                );
              } catch (reason) {
                setError(errorText(reason));
              }
            }}
          >
            Apply credentials
          </button>
        </>
      }
    >
      <p className="field-help">
        Change the accounts while keeping server addresses, transports, policy groups and chains.
        Save the Stash afterward to keep these changes.
      </p>
      <div className="editor-two-fields">
        <label className="editor-field">
          <span>Find servers</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage(0);
            }}
          />
        </label>
        <label className="check-control">
          <input
            type="checkbox"
            checked={show}
            onChange={(event) => setShow(event.currentTarget.checked)}
          />
          Show credentials
        </label>
      </div>
      <div className="item-list">
        {matches.slice(currentPage * 40, (currentPage + 1) * 40).map((row) => (
          <div className="pool-credential-row" key={row.key}>
            <div className="item-content">
              <strong>{row.entry.name}</strong>
              <small>
                {row.entry.protocol} · {row.entry.address} · {row.group.name}
              </small>
            </div>
            <div className="pool-credential-fields">
              {(edits.get(row.key) ?? row.fields).map((field, index) => (
                <label className="editor-field" key={JSON.stringify(field.path)}>
                  <span>
                    {field.label}
                    {row.fields.filter((item) => item.label === field.label).length > 1
                      ? ' (' + field.path.slice(1, -1).join('.') + ')'
                      : ''}
                  </span>
                  <input
                    type={show ? 'text' : 'password'}
                    autoComplete="off"
                    value={field.value}
                    aria-label={row.entry.name + ' · ' + field.label + ' · ' + index}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setEdits((current) => {
                        const next = new Map(current);
                        const fields = (next.get(row.key) ?? row.fields).map((item, position) =>
                          position === index ? { ...item, value } : item,
                        );
                        if (
                          fields.every(
                            (item, position) => item.value === row.fields[position].value,
                          )
                        )
                          next.delete(row.key);
                        else next.set(row.key, fields);
                        return next;
                      });
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
        {!rows.length && (
          <p className="empty-state">
            No editable server credentials. Use Edit outbound for other connection settings.
          </p>
        )}
        {!!rows.length && !matches.length && <p className="empty-state">No matching servers.</p>}
      </div>
      <ResultPager
        count={matches.length}
        size={40}
        page={currentPage}
        label="Server credentials"
        onPage={setPage}
      />
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

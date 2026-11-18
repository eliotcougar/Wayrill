import { useDeferredValue, useMemo, useState } from 'react';
import Dialog from '../components/Dialog';
import ResultPager from '../components/ResultPager';
import type { Stash } from '../profiles/import';
import type { StashLink } from '../graph/types';
import { entryIsPrepared } from '../profiles/stashModel';
import { errorText } from '../serviceClient';

export type StashImportSource = { id: string; name: string; read: () => Stash; movable?: boolean };

export default function PoolStashImport({
  sources,
  aquifer,
  replacement,
  onImport,
  onClose,
}: {
  sources: StashImportSource[];
  aquifer: boolean;
  replacement?: string;
  onImport: (source: StashImportSource, links: StashLink[], move: boolean) => void;
  onClose: () => void;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [page, setPage] = useState(0);
  const [chosen, setChosen] = useState(new Set<string>());
  const [move, setMove] = useState(false);
  const [error, setError] = useState('');
  const source = sources.find(({ id }) => id === sourceId);
  const loaded = useMemo(() => {
    try {
      return { stash: source?.read(), error: '' };
    } catch (reason) {
      return { stash: undefined, error: errorText(reason) };
    }
  }, [source]);
  const rows = useMemo(
    () =>
      loaded.stash?.groups.flatMap((group) =>
        group.entries.map((entry) => ({
          group,
          entry,
          key: JSON.stringify([group.id, entry.id]),
        })),
      ) ?? [],
    [loaded.stash],
  );
  const term = useDeferredValue(query.trim().toLowerCase());
  const matches = useMemo(
    () =>
      rows.filter(
        ({ group, entry }) =>
          (kind === 'all' ||
            (kind === 'servers' ? !entryIsPrepared(entry) : entry.profile?.kind === kind)) &&
          [entry.name, entry.protocol, entry.address, group.name]
            .join(' ')
            .toLowerCase()
            .includes(term),
      ),
    [rows, kind, term],
  );
  const all = matches.length > 0 && matches.every(({ key }) => chosen.has(key));
  const some = matches.some(({ key }) => chosen.has(key));
  const links = rows
    .filter(({ key }) => chosen.has(key))
    .map(({ group, entry }) => ({ groupId: group.id, entryId: entry.id }));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / 60) - 1));
  return (
    <Dialog
      title={
        replacement
          ? 'Replace ' + replacement + ' from Aquifer'
          : aquifer
            ? 'Import Aquifer accounts'
            : 'Copy or move between Stashes'
      }
      className="pool-dialog pool-stash-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="field-help">{links.length} selected</span>
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!links.length || !source}
            onClick={() => {
              if (!source) return;
              try {
                onImport(source, links, move);
              } catch (reason) {
                setError(errorText(reason));
              }
            }}
          >
            {replacement ? 'Replace outbound' : move ? 'Move selected' : 'Copy selected'}
          </button>
        </>
      }
    >
      <label className="editor-field">
        <span>{aquifer ? 'Cached Aquifer server' : 'Source Stash'}</span>
        <select
          value={sourceId}
          onChange={(event) => {
            setSourceId(event.currentTarget.value);
            setChosen(new Set());
            setMove(false);
            setQuery('');
            setPage(0);
            setError('');
          }}
        >
          {sources.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {!sources.length && (
        <p className="field-help">
          {aquifer
            ? 'Read a server configuration in Aquifer to make its accounts available here.'
            : 'Create or duplicate another Stash layer to copy its entries here.'}
        </p>
      )}
      {source && (
        <>
          <div className="editor-two-fields">
            <label className="editor-field">
              <span>{aquifer ? 'Find account or server' : 'Find outbounds'}</span>
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setPage(0);
                }}
              />
            </label>
            {!aquifer && (
              <label className="editor-field">
                <span>Entry type</span>
                <select
                  value={kind}
                  onChange={(event) => {
                    setKind(event.currentTarget.value);
                    setPage(0);
                  }}
                >
                  <option value="all">All entries</option>
                  <option value="servers">Servers</option>
                  <option value="policy-group">Policy groups</option>
                  <option value="proxy-chain">Proxy chains</option>
                </select>
              </label>
            )}
          </div>
          {!replacement && (
            <label className="check-control">
              <input
                type="checkbox"
                checked={all}
                ref={(input) => {
                  if (input) input.indeterminate = !all && some;
                }}
                disabled={!matches.length || term !== query.trim().toLowerCase()}
                onChange={() =>
                  setChosen((current) => {
                    const next = new Set(current);
                    for (const { key } of matches) {
                      if (all) next.delete(key);
                      else next.add(key);
                    }
                    return next;
                  })
                }
              />
              Select all matching entries
            </label>
          )}
          <div className="item-list pool-stash-choices">
            {matches
              .slice(currentPage * 60, (currentPage + 1) * 60)
              .map(({ group, entry, key }) => (
                <label className="item-row check-control" key={key}>
                  <input
                    type={replacement ? 'radio' : 'checkbox'}
                    name={replacement ? 'replacement-account' : undefined}
                    checked={chosen.has(key)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setChosen((current) => {
                        const next = replacement ? new Set<string>() : new Set(current);
                        if (checked) next.add(key);
                        else next.delete(key);
                        return next;
                      });
                    }}
                  />
                  <span className="item-content">
                    <strong>{entry.name}</strong>
                    <small>
                      {group.name} · {entry.protocol} {entry.address}
                    </small>
                  </span>
                </label>
              ))}
            {!matches.length && <p className="empty-state">No matching entries.</p>}
          </div>
          <ResultPager
            count={matches.length}
            size={60}
            page={currentPage}
            label="Stash entries"
            onPage={setPage}
          />
          {source.movable && (
            <label className="check-control">
              <input
                type="checkbox"
                checked={move}
                onChange={(event) => setMove(event.currentTarget.checked)}
              />
              Move selected entries out of the source Stash when I save
            </label>
          )}
          <p className="field-help">
            {replacement
              ? 'The selected connection replaces this server’s settings. Its name, graph references, policy memberships and chain hops are retained.'
              : aquifer
                ? 'These are copies of the cached connection settings. Edit the imported entries to change credentials or endpoints.'
                : 'Referenced servers and subscription pools are copied with policy groups and chains. Changes take effect when you save this Stash.'}
          </p>
        </>
      )}
      {(error || loaded.error) && (
        <p className="notice notice--error" role="alert">
          {error || loaded.error}
        </p>
      )}
    </Dialog>
  );
}

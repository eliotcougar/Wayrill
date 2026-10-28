import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, X } from 'lucide-react';
import {
  geoExpression,
  geoSources,
  parseGeoExpression,
  type GeoGroup,
  type GeoEntry,
  type GeoPage,
} from '../geodata';
import { resourceFilename, type ResourceKind, type ResourceSet } from '../graph/resources';
import { errorText, serviceCall } from '../serviceClient';
import useModalDialog from './useModalDialog';

function usePage(
  params: (Record<string, unknown> & { offset: number; limit: number }) | null,
  revision: string,
  changeOffset: (offset: number) => void,
) {
  const key = JSON.stringify([params, revision]);
  const [state, setState] = useState<{ key: string; page?: GeoPage; error?: string }>({ key: '' });
  useEffect(() => {
    const [input] = JSON.parse(key) as [typeof params, string];
    if (!input) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const page = await serviceCall<GeoPage>('resources.browse', input);
        if (!active) return;
        if (!page.ready) {
          timer = setTimeout(() => void read(), 250);
          return;
        }
        const total = page.total ?? 0;
        if (input.offset > 0 && input.offset >= total) {
          changeOffset(Math.max(0, Math.ceil(total / input.limit) - 1) * input.limit);
          return;
        }
        setState({ key, page });
      } catch (error) {
        if (!active) return;
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['BUSY', 'RESOURCE_CHANGED'].includes(String(error.code))
        ) {
          timer = setTimeout(() => void read(), 350);
          return;
        }
        setState({ key, error: errorText(error) });
      }
    };
    timer = setTimeout(() => void read(), 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, changeOffset]);
  const previous = state.key
    ? (JSON.parse(state.key) as [Record<string, unknown> | null, string])[0]
    : null;
  const sameGroup =
    previous &&
    params &&
    ['file', 'kind', 'group'].every((name) => previous[name] === params[name]);
  return {
    key,
    page: state.key === key ? state.page : undefined,
    error: state.key === key ? state.error : undefined,
    group: sameGroup ? state.page?.group : undefined,
  };
}
function Pages({
  offset,
  total,
  change,
}: {
  offset: number;
  total: number;
  change: (v: number) => void;
}) {
  return (
    <div className="action-row action-row--spread geo-pages">
      <button
        type="button"
        className="icon-button"
        aria-label="Previous page"
        disabled={!offset}
        onClick={() => change(Math.max(0, offset - 100))}
      >
        <ChevronLeft size={16} />
      </button>
      <span>
        {total
          ? `${offset + 1}–${Math.min(offset + 100, total)} / ${total.toLocaleString()}`
          : '0 results'}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Next page"
        disabled={offset + 100 >= total}
        onClick={() => change(offset + 100)}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
export default function GeodataBrowser({
  kind,
  resources,
  initialExpression = '',
  onClose,
  onInsert,
}: {
  kind: ResourceKind;
  resources: ResourceSet;
  initialExpression?: string;
  onClose: () => void;
  onInsert: (entry: string) => string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    search.current?.focus();
  }, []);
  const sources = useMemo(() => geoSources(resources, kind), [resources, kind]);
  const [browseFile, setFile] = useState(
    () => parseGeoExpression(initialExpression, sources, kind).value?.file ?? sources[0].file,
  );
  const [expression, setExpression] = useState(initialExpression);
  const parsed = useMemo(
    () => parseGeoExpression(expression, sources, kind),
    [expression, sources, kind],
  );
  const selection = parsed.value;
  const file = selection?.file ?? browseFile;
  const source = sources.find((s) => s.file === file) ?? sources[0];
  const [query, setQuery] = useState(
    () => parseGeoExpression(initialExpression, sources, kind).value?.group ?? '',
  );
  const [offset, setOffset] = useState(0);
  const [entryQuery, setEntryQuery] = useState('');
  const [entryOffset, setEntryOffset] = useState(0);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [present, setPresent] = useState<Set<string> | null>(null);
  useEffect(() => {
    let active = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const status = await serviceCall<{
          generation: number;
          files: { file: string; present: boolean }[];
        }>('resources.status');
        if (active) {
          setGeneration(status.generation);
          setPresent(new Set(status.files.filter((f) => f.present).map((f) => f.file)));
        }
      } catch {
        /* The browser page reports its actionable connection/read error. */
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const revision = `${generation}:${refresh}`;
  const listing = usePage({ file, kind, query, offset, limit: 100 }, revision, setOffset);
  const entries = usePage(
    selection
      ? {
          file,
          kind,
          group: selection.group,
          attributes: selection.attributes,
          inverse: selection.inverse,
          cidr: selection.cidr,
          query: entryQuery,
          offset: entryOffset,
          limit: 100,
        }
      : null,
    revision,
    setEntryOffset,
  );
  const insert = (entry: string) => {
    const problem = onInsert(entry);
    if (problem) setError(problem);
  };
  const selectGroup = (code: string) => {
    const prefix = selection?.file === file && selection.prefix ? selection.prefix : source.prefix;
    setExpression(`${prefix}${code}`);
    setEntryQuery('');
    setEntryOffset(0);
    setError('');
  };
  const attributes = [
    ...new Set([
      ...(entries.group?.attributes ?? []).filter((a) => a === a.toLowerCase()),
      ...(selection?.attributes ?? []),
    ]),
  ].sort();
  const toggleAttribute = (attribute: string, checked: boolean) => {
    if (!selection) return;
    setExpression(
      geoExpression({
        ...selection,
        attributes: checked
          ? [...selection.attributes, attribute]
          : selection.attributes.filter((a) => a !== attribute),
      }),
    );
    setEntryOffset(0);
    setError('');
  };
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window geo-browser"
      aria-labelledby="geo-browser-title"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClose={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="rule-editor-titlebar">
        <h2 id="geo-browser-title">{kind === 'geosite' ? 'GeoSite' : 'GeoIP'}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close resource browser"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="action-row action-row--spread geo-source">
        <label>
          Resource file
          <select
            className="text-control"
            aria-label="Resource file"
            value={file}
            onChange={(e) => {
              setFile(e.target.value);
              setExpression('');
              setEntryQuery('');
              setEntryOffset(0);
              setError('');
              setOffset(0);
            }}
          >
            {sources.map(
              (s, i) =>
                (i === 0 ||
                  s.file === file ||
                  resources.files.some((extra) => s.file === resourceFilename(extra)) ||
                  !present ||
                  present.has(s.file)) && (
                  <option key={s.file} value={s.file}>
                    {s.label}
                  </option>
                ),
            )}
          </select>
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh resource browser"
          title="Refresh"
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="geo-columns">
        <section className="geo-groups" aria-label="Resource groups">
          <input
            className="text-control"
            ref={search}
            maxLength={256}
            aria-label="Search groups"
            placeholder="Search groups"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
          {listing.error ? (
            <p role="alert">{listing.error}</p>
          ) : !listing.page ? (
            <p role="status">Loading groups…</p>
          ) : (
            <>
              <div className="geo-scroll">
                <table className="data-table data-table--compact data-table--sticky">
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th>Entries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(listing.page.rows as GeoGroup[]).map((g) => (
                      <tr
                        key={g.code}
                        className={selection?.group.toLowerCase() === g.code ? 'selected' : ''}
                        onClick={() => selectGroup(g.code)}
                      >
                        <td>
                          <button
                            type="button"
                            aria-pressed={selection?.group.toLowerCase() === g.code}
                          >
                            {g.code}
                          </button>
                        </td>
                        <td>{g.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pages offset={offset} total={listing.page.total ?? 0} change={setOffset} />
            </>
          )}
        </section>
        <section className="geo-entries" aria-label="Expression preview">
          <label className="geo-expression">
            Expression
            <input
              className="text-control code-control"
              aria-label={`${kind === 'geosite' ? 'GeoSite' : 'GeoIP'} expression`}
              value={expression}
              maxLength={4096}
              spellCheck={false}
              placeholder={
                kind === 'geosite' ? 'geosite:group@attribute' : 'geoip:group or !geoip:group'
              }
              onChange={(e) => {
                const next = parseGeoExpression(e.target.value, sources, kind).value;
                if (next?.group !== selection?.group || next?.file !== selection?.file)
                  setEntryQuery('');
                setExpression(e.target.value);
                setEntryOffset(0);
                setError('');
              }}
            />
          </label>
          {parsed.error ? (
            <p className="geo-error" role="alert">
              {parsed.error}
            </p>
          ) : !selection ? (
            <p className="empty-state geo-empty">Select a group</p>
          ) : (
            <>
              {kind === 'geosite' && attributes.length > 0 && (
                <fieldset
                  className="geo-attributes"
                  title="All selected attributes must be present. ! is part of an attribute name."
                >
                  <legend>Attributes · match all selected</legend>
                  <div>
                    <label className="check-control check-control--compact">
                      <input
                        type="checkbox"
                        checked={!selection.attributes.length}
                        onChange={() => {
                          setExpression(geoExpression({ ...selection, attributes: [] }));
                          setEntryOffset(0);
                        }}
                      />
                      All entries
                    </label>
                    {attributes.map((a) => (
                      <label key={a} className="check-control check-control--compact">
                        <input
                          type="checkbox"
                          aria-label={`Attribute @${a}`}
                          checked={selection.attributes.includes(a)}
                          onChange={(e) => toggleAttribute(a, e.target.checked)}
                        />
                        @{a}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {kind === 'geoip' && (
                <label className="check-control">
                  <input
                    type="checkbox"
                    checked={selection.inverse}
                    onChange={(e) => {
                      setExpression(geoExpression({ ...selection, inverse: e.target.checked }));
                      setEntryOffset(0);
                      setError('');
                    }}
                  />
                  Invert selection
                </label>
              )}
              <input
                className="text-control"
                maxLength={256}
                aria-label="Search preview"
                placeholder={
                  kind === 'geosite' ? 'Search matching entries' : 'Search matching ranges'
                }
                value={entryQuery}
                onChange={(e) => {
                  setEntryQuery(e.target.value);
                  setEntryOffset(0);
                }}
              />
              {entries.error ? (
                <p role="alert">{entries.error}</p>
              ) : !entries.page ? (
                <p role="status">Loading contents…</p>
              ) : (
                <>
                  <div className="geo-scroll">
                    <table className="data-table data-table--compact">
                      <tbody>
                        {(entries.page.rows as GeoEntry[]).map((e, i) => (
                          <tr key={i}>
                            <td>
                              <code>{e.preview}</code>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="icon-button"
                                title="Insert this entry"
                                aria-label={`Insert ${e.preview}`}
                                disabled={!e.value}
                                onClick={() => e.value && insert(e.value)}
                              >
                                <Plus size={14} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pages
                    offset={entryOffset}
                    total={entries.page.total ?? 0}
                    change={setEntryOffset}
                  />
                </>
              )}
            </>
          )}
        </section>
      </div>
      <div className="rule-editor-footer">
        {error && <p role="alert">{error}</p>}
        <button type="button" className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!selection || !entries.page || Boolean(entries.error)}
          onClick={() => insert(expression.trim())}
        >
          Insert expression
        </button>
      </div>
    </dialog>
  );
}

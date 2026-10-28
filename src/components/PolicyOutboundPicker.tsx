import { jsonText } from '../graph/xrayJson';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { nativePoolNodes } from '../graph/nativePool';
import { isOutboundKind } from '../graph/outbounds';
const isXrayOutbound = (node: import('../graph/types').RuleNode) => isOutboundKind(node.data.kind);
import { policyProfile, type PolicyReference } from '../graph/policySources';
import type { GraphState } from '../graph/types';
import type { Stash } from '../profiles/import';
import { libraryRows, libraryTerm, searchLibrary } from '../profiles/library';
import ResultPager from './ResultPager';
import { searchText } from '../text';

export default function PolicyOutboundPicker({
  graph,
  stash,
  label,
  onSelect,
  selected,
  single = false,
  actions,
  excludeId,
}: {
  graph: GraphState;
  stash: Stash;
  label: string;
  onSelect: (reference: PolicyReference) => void;
  selected?: PolicyReference;
  single?: boolean;
  actions?: ReactNode;
  excludeId?: string;
}) {
  const [open, setOpen] = useState(false),
    [poolOpen, setPoolOpen] = useState(false),
    [query, setQuery] = useState(''),
    [groupId, setGroupId] = useState(''),
    [page, setPage] = useState(0);
  const deferred = useDeferredValue(libraryTerm(query)),
    pending = deferred !== libraryTerm(query);
  const indexed = useMemo(() => (open ? libraryRows(stash.groups) : []), [open, stash]);
  const matches = useMemo(
    () => searchLibrary(indexed, deferred, groupId, true),
    [indexed, deferred, groupId],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / 30) - 1));
  const poolMatches = useMemo(() => {
    if (!poolOpen) return [];
    const term = deferred;
    return nativePoolNodes(graph).filter(
      (n) =>
        !term ||
        searchText(`${n.data.label} ${jsonText(n.data.native?.original.protocol ?? '')}`).includes(
          term,
        ),
    );
  }, [graph, deferred, poolOpen]);
  const poolPage = Math.min(page, Math.max(0, Math.ceil(poolMatches.length / 30) - 1));
  const select = (reference: PolicyReference) => {
    onSelect(reference);
    if (single) {
      setOpen(false);
      setPoolOpen(false);
    }
  };
  const selectionValue = selected
    ? selected.type === 'node' &&
      graph.nodes.some((n) => n.id === selected.nodeId && isXrayOutbound(n))
      ? selected.nodeId
      : '__current__'
    : '';
  return (
    <div className="policy-picker">
      <div className="form-row policy-picker-actions">
        <label className="editor-field">
          <span>{label} from graph</span>
          <select
            value={selectionValue}
            aria-label={`${label} from graph`}
            onChange={(e) => {
              if (e.target.value && e.target.value !== '__current__')
                select({ type: 'node', nodeId: e.target.value });
            }}
          >
            <option value="">Choose an outbound…</option>
            {selectionValue === '__current__' && selected && (
              <option value="__current__">
                {selected.type === 'profile'
                  ? selected.name
                  : (nativePoolNodes(graph).find((n) => n.id === selected.nodeId)?.data.label ??
                    'Missing outbound')}
                {selected.type === 'profile' ? ' · copied outbound' : ' · imported pool'}
              </option>
            )}
            {graph.nodes
              .filter((n) => n.id !== excludeId && isXrayOutbound(n))
              .map((node) => (
                <option value={node.id} key={node.id}>
                  {node.data.label} · {String(node.data.settings.tag)}
                </option>
              ))}
          </select>
        </label>
        <button
          className="secondary-button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setPoolOpen(false);
            setPage(0);
          }}
        >
          {open ? `Close ${label.toLowerCase()} stash picker` : `${label} from stash…`}
        </button>
        {!!graph.xray?.outboundPool?.length && (
          <button
            className="secondary-button"
            aria-expanded={poolOpen}
            onClick={() => {
              setPoolOpen(!poolOpen);
              setOpen(false);
              setPage(0);
            }}
          >
            {poolOpen ? `Close ${label.toLowerCase()} pool picker` : `${label} from imported pool…`}
          </button>
        )}
        {actions}
      </div>
      {poolOpen && (
        <div
          className="editor-panel policy-stash-picker"
          role="region"
          aria-label={`${label} picker`}
          aria-busy={pending}
        >
          <label className="editor-field">
            <span>Search imported outbounds</span>
            <input
              autoComplete="off"
              aria-label={`${label}: search imported outbounds`}
              value={query}
              placeholder="Tag or protocol"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          {pending && (
            <p role="status" className="field-help">
              Updating search…
            </p>
          )}
          <ResultPager
            compact
            label={`${label}: imported pool`}
            count={poolMatches.length}
            size={30}
            page={poolPage}
            disabled={pending}
            onPage={setPage}
          />
          <div className="item-list policy-picker-list">
            {poolMatches.slice(poolPage * 30, (poolPage + 1) * 30).map((node) => (
              <div className="item-row policy-picker-row" key={node.id}>
                <span className="item-content">
                  <strong dir="auto" title={node.data.label}>
                    {node.data.label}
                  </strong>
                  <small>{jsonText(node.data.native?.original.protocol ?? '').toUpperCase()}</small>
                </span>
                <button
                  className="secondary-button"
                  aria-label={`Add ${node.data.label} to ${label.toLowerCase()}`}
                  disabled={pending}
                  onClick={() => select({ type: 'node', nodeId: node.id })}
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {open && (
        <div
          className="editor-panel policy-stash-picker"
          role="region"
          aria-label={`${label} picker`}
          aria-busy={pending}
        >
          <div className="editor-two-fields">
            <label className="editor-field">
              <span>Search stash outbounds</span>
              <input
                autoComplete="off"
                aria-label={`${label}: search stash outbounds`}
                value={query}
                placeholder="Name, server or protocol"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label className="editor-field">
              <span>Stash group</span>
              <select
                aria-label={`${label}: stash group`}
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">All groups</option>
                {stash.groups.map((g) => (
                  <option value={g.id} key={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="field-help">
            Scope: {groupId ? stash.groups.find((g) => g.id === groupId)?.name : 'all stash groups'}
            . Adding copies the configuration; subscription refreshes do not change this entry.
          </p>
          {pending && (
            <p role="status" className="field-help">
              Updating search…
            </p>
          )}
          <ResultPager
            compact
            label={`${label}: stash`}
            count={matches.length}
            size={30}
            page={currentPage}
            disabled={pending}
            onPage={setPage}
          />
          <div className="item-list policy-picker-list">
            {matches.slice(currentPage * 30, (currentPage + 1) * 30).map(({ group, entry }) => (
              <div className="item-row policy-picker-row" key={`${group.id}/${entry.id}`}>
                <span className="item-content">
                  <strong dir="auto" title={entry.name}>
                    {entry.name}
                  </strong>
                  <small>
                    {entry.profile?.kind === 'policy-group'
                      ? 'Policy group'
                      : entry.profile?.kind === 'proxy-chain'
                        ? 'Proxy chain'
                        : entry.protocol.toUpperCase()}{' '}
                    {entry.address && ' · ' + entry.address} · <bdi>{group.name}</bdi>
                  </small>
                </span>
                <button
                  className="secondary-button"
                  aria-label={`Add ${entry.name} to ${label.toLowerCase()}`}
                  disabled={pending}
                  onClick={() =>
                    select(policyProfile(entry, { groupId: group.id, entryId: entry.id }))
                  }
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import StashStar from './StashStar';
import OutboundTestButtons from './OutboundTestButtons';
import { OutboundTestSummary } from '../useOutboundTests';
import { stashRows, entryLink, type StashEntryEdit } from '../profiles/stashModel';
import { stashEditorNode, snapshotGraphEntry } from '../profiles/workspace';
import { useDeferredValue, useMemo, useState, useRef, useEffect } from 'react';
import { Plus, Trash2, Copy, Pencil, LockKeyhole, LockKeyholeOpen } from 'lucide-react';
import { libraryTerm } from '../profiles/library';
import { makeNode } from '../graph/catalog';
import { checkPrepared } from '../profiles/preparedPreviewClient';
import { boundedText } from '../text';
import type { GraphState, RuleNode, StashLink } from '../graph/types';
import type { Stash, StashEntry } from '../profiles/import';
import PolicyEditor from './PolicyEditor';
import ProxyChainEditor from './ProxyChainEditor';
import ResultPager from './ResultPager';
import { factoryDefaults } from '../graph/defaults';

export default function PreparedOutboundLibrary({
  kind,
  query,
  onQueryChange,
  stash,
  graph,
  ready,
  replace,
  chosen,
  onChoose,
  onUse,
  onSave,
  onDelete,
  onLock,
  onStar,
}: {
  kind: 'policy-group' | 'proxy-chain';
  query: string;
  onQueryChange: (query: string) => void;
  stash: Stash;
  graph?: GraphState;
  ready: boolean;
  replace: boolean;
  chosen?: StashLink;
  onChoose: (entry: StashEntry) => void;
  onUse: (entry: StashEntry) => void;
  onSave: (entry: StashEntry, edit?: StashEntryEdit) => void;
  onDelete: (entry: StashEntry) => void;
  onLock: (entry: StashEntry) => void;
  onStar: (entry: StashEntry) => void;
}) {
  const entries = useMemo(() => stashRows(stash, kind).map((row) => row.entry), [stash, kind]);
  const [page, setPage] = useState(0),
    [error, setError] = useState('');
  const [editing, setEditing] = useState<{
    node: RuleNode;
    graph: GraphState;
    edit?: StashEntryEdit;
  }>();
  const term = useDeferredValue(libraryTerm(query));
  const matches = useMemo(
    () => entries.filter((e) => !term || libraryTerm(e.name).includes(term)),
    [entries, term],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / 60) - 1));
  const begin = (entry?: StashEntry) => {
    const context = graph ?? {
      name: 'Prepared outbounds',
      nodes: [],
      edges: [],
      defaults: factoryDefaults(),
    };
    const id = 'stash-edit-' + crypto.randomUUID();
    const node =
      entry && (entry.profile || entry.draft)
        ? stashEditorNode(entry, context, id)
        : makeNode(kind, { x: 0, y: 0 }, id);
    setEditing({
      node,
      graph: { ...context, nodes: [...context.nodes, node] },
      edit: entry ? { entry, link: entryLink(stash, entry) } : undefined,
    });
    setError('');
  };
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), [editing]);
  const save = async (next: GraphState) => {
    const controller = new AbortController();
    operation.current = controller;
    await checkPrepared(
      next,
      next.nodes.find((n) => n.id === editing!.node.id)!,
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const entry = snapshotGraphEntry(
      next,
      next.nodes.find((n) => n.id === editing!.node.id)!,
      editing!.edit?.entry.id,
      editing!.edit?.entry,
    );
    onSave(entry, editing!.edit);
  };
  const safe = (action: () => void) => {
    try {
      action();
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section
      className="prepared-library"
      aria-label={kind === 'policy-group' ? 'Prepared policy groups' : 'Prepared proxy chains'}
    >
      <div className="action-row stash-toolbar">
        <button className="primary-button" disabled={!ready} onClick={() => begin()}>
          <Plus size={14} />
          {kind === 'policy-group' ? 'New policy group' : 'New proxy chain'}
        </button>
        <label className="editor-field prepared-search">
          <span>Search</span>
          <input
            autoComplete="off"
            value={query}
            onChange={(e) => {
              onQueryChange(e.target.value);
              setPage(0);
            }}
            placeholder="Name"
          />
        </label>
      </div>
      {error && (
        <div role="alert" className="notice notice--error">
          {error}
        </div>
      )}
      <div className="stash-entries">
        {matches.slice(currentPage * 60, (currentPage + 1) * 60).map((entry) => (
          <div className="stash-entry" key={JSON.stringify(entryLink(stash, entry))}>
            <div className="stash-entry-main">
              <strong dir="auto" title={entry.name}>
                {entry.name}
              </strong>
              <small>
                {stash.groups.find((g) => g.id === entryLink(stash, entry).groupId)?.name} ·{' '}
                {kind === 'policy-group' ? 'Policy group' : 'Proxy chain'}
                {entry.problem ? ' · Incomplete' : ''}
              </small>
              <OutboundTestSummary entry={entry} stash={stash} />
            </div>
            <div className="stash-entry-actions">
              <OutboundTestButtons
                entries={[entry]}
                name={entry.name}
                disabled={!ready || !entry.profile}
              />
              <StashStar
                entry={entry}
                disabled={!ready}
                onToggle={() => safe(() => onStar(entry))}
              />
              <button
                className="icon-button"
                disabled={!ready}
                aria-pressed={!!entry.locked}
                title={
                  entry.locked ? 'Unlock subscription updates' : 'Lock against subscription updates'
                }
                aria-label={(entry.locked ? 'Unlock ' : 'Lock ') + entry.name}
                onClick={() => safe(() => onLock(entry))}
              >
                {entry.locked ? <LockKeyhole size={15} /> : <LockKeyholeOpen size={15} />}
              </button>
              <button
                className="icon-button"
                disabled={!ready}
                aria-label={'Edit ' + entry.name}
                onClick={() => begin(entry)}
              >
                <Pencil size={15} />
              </button>
              <button
                className="icon-button"
                disabled={!ready}
                aria-label={'Duplicate ' + entry.name}
                onClick={() =>
                  safe(() =>
                    onSave({
                      ...structuredClone(entry),
                      id: crypto.randomUUID(),
                      locked: false,
                      starred: false,
                      name: boundedText(entry.name + ' copy', 128),
                    }),
                  )
                }
              >
                <Copy size={15} />
              </button>
              <button
                className="icon-button"
                disabled={!ready}
                aria-label={'Delete ' + entry.name}
                onClick={() => safe(() => onDelete(entry))}
              >
                <Trash2 size={15} />
              </button>
              {replace ? (
                <label className="check-control stash-choice">
                  <input
                    autoComplete="off"
                    type="radio"
                    name="prepared-replacement"
                    aria-label={'Select ' + entry.name + ' for replacement'}
                    checked={
                      chosen?.entryId === entry.id &&
                      chosen.groupId === entryLink(stash, entry).groupId
                    }
                    onChange={() => onChoose(entry)}
                  />
                  <span>Select</span>
                </label>
              ) : (
                <button
                  className="secondary-button"
                  disabled={!ready || !entry.profile}
                  aria-label={'Add ' + entry.name + ' to graph'}
                  onClick={() => safe(() => onUse(entry))}
                >
                  <Plus size={13} />
                  Add node
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {!matches.length && (
        <p className="stash-empty">
          {entries.length
            ? 'No matching outbounds.'
            : kind === 'policy-group'
              ? 'Create a group from subscription filters or saved outbounds.'
              : 'Create a chain from saved outbounds, policy groups, or other chains.'}
        </p>
      )}
      <ResultPager
        label={kind === 'policy-group' ? 'Policy groups' : 'Proxy chains'}
        count={matches.length}
        size={60}
        page={currentPage}
        onPage={setPage}
      />
      {editing &&
        (kind === 'policy-group' ? (
          <PolicyEditor
            node={editing.node}
            graph={editing.graph}
            stash={stash}
            onApply={save}
            onClose={() => setEditing(undefined)}
            applyLabel="Save to stash"
          />
        ) : (
          <ProxyChainEditor
            node={editing.node}
            graph={editing.graph}
            stash={stash}
            onApply={save}
            onClose={() => setEditing(undefined)}
            applyLabel="Save to stash"
          />
        ))}
    </section>
  );
}

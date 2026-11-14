import { EditorTabList, useEditorTabs } from '@wayrill/ui/EditorTabs';
import StashOutboundPicker from '@wayrill/ui/StashOutboundPicker';
import { useEffect, useRef, useState } from 'react';
import { Archive, LocateFixed, Pencil, Plus, Search, X } from 'lucide-react';
import { routingDestinations, type RemoteView } from './remoteModel';
import { createRemoteNode, nodeLibrary } from './remoteCreation';
import { nodeSettings, replaceNodeSettings } from './nodeSettings';
import RemoteSettings from './RemoteSettings';
import {
  chainPath,
  configuredOutbounds,
  stashNodes,
  stashTabs,
  type StashTab,
} from './remoteStashModel';
import { get } from './nativeProperties';
import { jsonText } from './graph/xrayJson';

const outboundTypes = nodeLibrary
  .filter(({ category, protocol }) => category === 'outbound' && protocol)
  .map(({ id, title }) => ({ id, name: title }));
const PAGE_SIZE = 100;

export default function RemoteStash({
  view,
  visible,
  canAdd,
  onAdd,
  onEdit,
  onEditChain,
  onShow,
  onClose,
}: {
  view: RemoteView;
  visible: ReadonlySet<string>;
  canAdd: () => boolean;
  onAdd: (view: RemoteView) => void;
  onEdit: (id: string) => void;
  onEditChain: (id: string) => void;
  onShow: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [creation, setCreation] = useState<
    ReturnType<typeof createRemoteNode> & { base: RemoteView }
  >();
  const newOutbound = creation && nodeSettings(creation.view, creation.id);
  const [tab, setTab] = useState<StashTab>('outbounds'),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(0);
  const editorTabs = useEditorTabs(stashTabs, tab, (key) => {
    setTab(key);
    setPage(0);
  });
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const entries = stashNodes(view, tab),
    allOutbounds = configuredOutbounds(view);
  const byTag = new Map(allOutbounds.map((item, index) => [get(item, 'tag'), index]));
  const names = new Map(view.nodes.map((node) => [node.id, node.data.title]));
  const references = new Map(entries.map((node) => [node.id, new Set(node.data.references ?? [])]));
  for (const edge of view.edges) {
    // Outbound links already have a named Dial-through reference.
    if (edge.source.startsWith('native-out-')) continue;
    const name = names.get(edge.source);
    if (name) references.get(edge.target)?.add(name);
  }
  const chain = (id: string) => {
    const path = chainPath(allOutbounds, Number(id.slice(11)), byTag);
    return (
      path.error ||
      path.indices
        .map((index) => jsonText(get(allOutbounds[index], 'tag')) || `Outbound ${index + 1}`)
        .join(' → ')
    );
  };
  const filtered = entries.filter(({ id, data }) =>
    [data.title, data.subtitle, ...(references.get(id) ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)),
    active = Math.min(page, pages - 1);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [active, query, tab]);
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window user-library-dialog remote-stash-dialog"
      aria-label="Configuration stash"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-header">
        <h2>
          <Archive size={18} />
          Configuration stash
        </h2>
        <button className="icon-button" aria-label="Close stash" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <EditorTabList
        tabs={editorTabs}
        panelId={`${editorTabs.id}-panel`}
        label="Stash categories"
        className="editor-tab-list inspector-tabs stash-tabs"
      />
      <div className="user-library-tools">
        <label className="search-control">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Find stashed configurations"
            placeholder={`Search ${stashTabs.find((item) => item.key === tab)!.label.toLowerCase()}`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        {tab === 'outbounds' && (
          <button className="secondary-button" onClick={() => canAdd() && setAdding(true)}>
            <Plus size={14} /> Add outbound
          </button>
        )}
        <span>
          {filtered.length} / {entries.length}
        </span>
      </div>
      <div
        className="dialog-body remote-stash-body"
        ref={body}
        id={`${editorTabs.id}-panel`}
        role="tabpanel"
        aria-labelledby={editorTabs.tabId(tab)}
      >
        <table className="data-table data-table--sticky">
          <thead>
            <tr>
              <th>
                {tab === 'policyGroups'
                  ? 'Policy group'
                  : tab === 'proxyChains'
                    ? 'Proxy chain'
                    : 'Outbound'}
              </th>
              <th>{tab === 'proxyChains' ? 'Path' : 'Type'}</th>
              <th>Used by</th>
              <th>Graph</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(active * PAGE_SIZE, (active + 1) * PAGE_SIZE).map(({ id, data }) => (
              <tr key={id}>
                <td>{data.title}</td>
                <td>{tab === 'proxyChains' ? chain(id) : data.subtitle}</td>
                <td>{[...(references.get(id) ?? [])].join(' · ') || '—'}</td>
                <td>{visible.has(id) ? 'On graph' : 'Not on graph'}</td>
                <td>
                  <div className="remote-stash-actions">
                    <button
                      className="icon-button"
                      aria-label={`Edit ${data.title}`}
                      title={`Edit ${data.title}`}
                      onClick={() => (tab === 'proxyChains' ? onEditChain(id) : onEdit(id))}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={visible.has(id) ? 'Locate on graph' : 'Add to graph'}
                      title={visible.has(id) ? 'Locate on graph' : 'Add to graph'}
                      onClick={() => onShow(id)}
                    >
                      {visible.has(id) ? <LocateFixed size={16} /> : <Plus size={16} />}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="stash-empty">
            {entries.length
              ? 'No matching configurations'
              : `No ${stashTabs.find((item) => item.key === tab)!.label.toLowerCase()}`}
          </p>
        )}
      </div>
      <footer className="dialog-footer stash-pagination">
        {filtered.length > PAGE_SIZE && (
          <>
            <button
              className="secondary-button"
              disabled={!active}
              onClick={() => setPage(active - 1)}
            >
              Previous
            </button>
            <span>
              {active * PAGE_SIZE + 1}–{Math.min((active + 1) * PAGE_SIZE, filtered.length)} of{' '}
              {filtered.length}
            </span>
            <button
              className="secondary-button"
              disabled={active === pages - 1}
              onClick={() => setPage(active + 1)}
            >
              Next
            </button>
          </>
        )}
        <button className="secondary-button stash-close" onClick={onClose}>
          Close
        </button>
      </footer>
      {adding && (
        <StashOutboundPicker
          types={outboundTypes}
          onContinue={(kind) => {
            setCreation({ ...createRemoteNode(view, kind), base: view });
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {creation && newOutbound && (
        <RemoteSettings
          {...newOutbound}
          title={
            creation.view.nodes.find((node) => node.id === creation.id)?.data.title ?? 'Outbound'
          }
          destinations={routingDestinations(creation.view)}
          saveLabel="Save to Stash"
          onSave={(value) => {
            if (view !== creation.base)
              throw new Error(
                'The configuration changed. Reopen the outbound editor and try again.',
              );
            const next = replaceNodeSettings(creation.view, creation.id, value);
            onAdd(next);
            setCreation(undefined);
            setQuery('');
            setPage(Math.floor((stashNodes(next, 'outbounds').length - 1) / PAGE_SIZE));
          }}
          onClose={() => setCreation(undefined)}
        />
      )}
    </dialog>
  );
}

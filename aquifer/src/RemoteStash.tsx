import { EditorTabList, useEditorTabs } from '@wayrill/ui/EditorTabs';
import { useEffect, useRef, useState } from 'react';
import { Archive, X } from 'lucide-react';
import type { RemoteView } from './remoteModel';
import {
  chainPath,
  configuredOutbounds,
  stashNodes,
  stashTabs,
  type StashTab,
} from './remoteStashModel';
import { get } from './nativeProperties';
import { jsonText } from './graph/xrayJson';

export default function RemoteStash({
  view,
  visible,
  onEdit,
  onEditChain,
  onShow,
  onClose,
}: {
  view: RemoteView;
  visible: ReadonlySet<string>;
  onEdit: (id: string) => void;
  onEditChain: (id: string) => void;
  onShow: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  const pages = Math.max(1, Math.ceil(filtered.length / 100)),
    active = Math.min(page, pages - 1);
  return (
    <dialog
      ref={dialog}
      className="user-library-dialog remote-stash-dialog"
      aria-label="Configuration stash"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="user-dialog-header">
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
        className="inspector-tabs stash-tabs"
      />
      <div className="user-library-tools">
        <input
          aria-label="Find stashed configurations"
          placeholder={`Search ${stashTabs.find((item) => item.key === tab)!.label.toLowerCase()}`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        <span>
          {filtered.length} / {entries.length}
        </span>
      </div>
      <div
        className="remote-stash-body"
        id={`${editorTabs.id}-panel`}
        role="tabpanel"
        aria-labelledby={editorTabs.tabId(tab)}
      >
        <table>
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
            {filtered.slice(active * 100, (active + 1) * 100).map(({ id, data }) => (
              <tr key={id}>
                <td>{data.title}</td>
                <td>{tab === 'proxyChains' ? chain(id) : data.subtitle}</td>
                <td>{[...(references.get(id) ?? [])].join(' · ') || '—'}</td>
                <td>{visible.has(id) ? 'On graph' : 'Not on graph'}</td>
                <td>
                  <div className="remote-stash-actions">
                    <button
                      aria-label={`Edit ${data.title}`}
                      onClick={() => (tab === 'proxyChains' ? onEditChain(id) : onEdit(id))}
                    >
                      Edit…
                    </button>
                    <button onClick={() => onShow(id)}>
                      {visible.has(id) ? 'Locate on graph' : 'Add to graph'}
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
      <footer className="user-dialog-footer stash-pagination">
        {filtered.length > 100 && (
          <>
            <button disabled={!active} onClick={() => setPage(active - 1)}>
              Previous
            </button>
            <span>
              {active * 100 + 1}–{Math.min((active + 1) * 100, filtered.length)} of{' '}
              {filtered.length}
            </span>
            <button disabled={active === pages - 1} onClick={() => setPage(active + 1)}>
              Next
            </button>
          </>
        )}
        <button className="stash-close" onClick={onClose}>
          Close
        </button>
      </footer>
    </dialog>
  );
}

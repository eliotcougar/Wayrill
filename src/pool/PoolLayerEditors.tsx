import { lazy, Suspense, useState } from 'react';
import { Copy, KeyRound, Server } from 'lucide-react';
import { ReactFlowProvider } from '@xyflow/react';
import ConfigurationStash from '../components/ConfigurationStash';
import { parseStash, serializeStash, type Stash } from '../profiles/import';
import { parseGraph, toDocument } from '../graph/model';
import useStash from '../profiles/useStash';
import { newPoolStash, openGraphLayer, type PoolGraphStarter } from './graphLayer';
import { capturePoolGraph, capturePoolStash, type PoolBundle } from './model';
import {
  addLinkedFilterPorts,
  graphLinks,
  resolveGraphLinks,
  withoutLinkedStashes,
} from './graphLinks';
import type { GraphState, PoolGraphLink } from '../graph/types';
import type { PoolLayer } from './layers';
import PoolGraphLinks from './PoolGraphLinks';
import PoolStashImport, { type StashImportSource } from './PoolStashImport';
import PoolStashCredentials from './PoolStashCredentials';
import { applyStashCredentials } from '../profiles/stashCredentials';
import { replaceStashServer, transferStashEntries } from '../profiles/stashTransfer';
import { findStashEntry, type StashEntryEdit } from '../profiles/stashModel';
import { cachedAccountStash, readObservedServers, type ObservedServer } from './accounts';
import { errorText } from '../serviceClient';

const GraphEditor = lazy(() => import('../App'));
const populatedGroups = (stash: Stash) =>
  stash.groups.filter((group) => group.entries.length).map((group) => group.id);

export function PoolGraphEditor({
  bundle,
  name,
  starter,
  layers,
  onSave,
  onClose,
}: {
  bundle?: PoolBundle;
  name?: string;
  starter?: PoolGraphStarter;
  layers: readonly PoolLayer[];
  onSave: (bundle: PoolBundle) => Promise<void>;
  onClose: () => void;
}) {
  const [initial] = useState(() => {
    let effective = bundle;
    if (bundle) {
      try {
        effective = resolveGraphLinks(bundle, layers);
      } catch {
        // Keep the editor available to repair a link after its source changes.
      }
    }
    const layer = openGraphLayer(effective, starter);
    layer.graph.poolLayerLinks = graphLinks(bundle);
    if (name) layer.graph.name = name;
    return layer;
  });
  const [editing, setEditing] = useState<{
    graph: GraphState;
    stash: Stash;
    apply: (graph: GraphState, stash: Stash) => void;
  }>();
  function bundleWithLinks(graph: GraphState, stash: Stash, links: PoolGraphLink[]) {
    const localStash = withoutLinkedStashes(stash, layers, links);
    return {
      ...capturePoolGraph(graph.name, graph, localStash, populatedGroups(localStash)),
      linkedLayers: links.length ? links : undefined,
    };
  }
  return (
    <div className="pool-layer-workspace">
      <ReactFlowProvider>
        <Suspense
          fallback={
            <p className="workspace-loading" role="status">
              Opening graph layer…
            </p>
          }
        >
          <GraphEditor
            layer={{
              ...initial,
              onClose,
              onEditLayers: (graph, stash, apply) => setEditing({ graph, stash, apply }),
              onSave: (graph, stash) => {
                const ids = new Set(graph.nodes.map(({ id }) => id));
                const links = (graph.poolLayerLinks ?? []).filter(
                  ({ target }) => !target || ids.has(target),
                );
                const bundle = bundleWithLinks(graph, stash, links);
                resolveGraphLinks(bundle, layers);
                return onSave(bundle);
              },
            }}
          />
        </Suspense>
      </ReactFlowProvider>
      {editing && (
        <PoolGraphLinks
          graph={editing.graph}
          layers={layers}
          onClose={() => setEditing(undefined)}
          onApply={(links) => {
            const graph = addLinkedFilterPorts(editing.graph, layers, links);
            const effective = resolveGraphLinks(
              {
                format: 'wayrill.pool',
                version: 3,
                name: graph.name,
                graph: JSON.stringify(toDocument(graph)),
                stash: serializeStash(
                  withoutLinkedStashes(editing.stash, layers, [
                    ...(graph.poolLayerLinks ?? []),
                    ...links,
                  ]),
                ),
                linkedLayers: links,
              },
              layers,
            );
            const nodes = new Map(
              parseGraph(effective.graph).nodes.map((node) => [node.id, node.data]),
            );
            editing.apply(
              {
                ...graph,
                nodes: graph.nodes.map((node) => ({ ...node, data: nodes.get(node.id)! })),
                poolLayerLinks: links,
              },
              parseStash(effective.stash),
            );
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

export function PoolStashEditor({
  stash,
  name,
  layers,
  servers,
  onSave,
  onClose,
}: {
  stash?: string;
  name: string;
  layers: readonly PoolLayer[];
  servers: readonly ObservedServer[];
  onSave: (stash: string, moved: ReadonlyMap<string, string>) => Promise<void>;
  onClose: () => void;
}) {
  const [initial] = useState(() => (stash ? parseStash(stash) : newPoolStash()));
  const store = useStash(initial);
  const [editing, setEditing] = useState<'stash' | 'aquifer' | 'credentials'>();
  const [cached, setCached] = useState(servers);
  const [moved, setMoved] = useState(new Map<string, string>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [replacement, setReplacement] = useState<StashEntryEdit>();
  async function openAccounts(target?: StashEntryEdit) {
    setLoading(true);
    setError('');
    try {
      setCached(await readObservedServers());
      setReplacement(target);
      setEditing('aquifer');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }
  const sources: StashImportSource[] =
    editing === 'aquifer'
      ? [
          ...(cached.length > 1
            ? [
                {
                  id: 'all-cached',
                  name: 'All cached servers',
                  read: () =>
                    cachedAccountStash(cached, replacement ? newPoolStash() : store.get()),
                },
              ]
            : []),
          ...cached.map((server) => ({
            id: server.id,
            name: server.name + ' · ' + server.path,
            read: () => cachedAccountStash([server], replacement ? newPoolStash() : store.get()),
          })),
        ]
      : layers.flatMap(({ id, name, data }) =>
          data.kind === 'stash'
            ? [
                {
                  id,
                  name,
                  movable: true,
                  read: () => parseStash(moved.get(id) ?? data.stash),
                },
              ]
            : [],
        );
  return (
    <>
      <ConfigurationStash
        store={store}
        layerMode
        title={'Edit Stash · ' + name}
        entryActions={(entry, link, disabled) => (
          <button
            className="icon-button"
            disabled={disabled || loading}
            aria-label={'Replace ' + entry.name + ' with Aquifer account'}
            title="Replace with an Aquifer account"
            onClick={() => void openAccounts({ entry, link })}
          >
            <Server size={15} />
          </button>
        )}
        extraActions={(disabled) => (
          <>
            <button
              className="secondary-button"
              disabled={disabled || loading}
              onClick={() => setEditing('stash')}
            >
              <Copy size={14} /> Copy / move from Stash…
            </button>
            <button
              className="secondary-button"
              disabled={disabled || loading}
              onClick={() => void openAccounts()}
            >
              <Server size={14} /> {loading ? 'Reading accounts…' : 'Import from Aquifer…'}
            </button>
            <button
              className="secondary-button"
              disabled={
                disabled || loading || !store.get().groups.some((group) => group.entries.length)
              }
              onClick={() => setEditing('credentials')}
            >
              <KeyRound size={14} /> Edit credentials…
            </button>
            {error && (
              <span className="field-message error" role="alert">
                {error}
              </span>
            )}
          </>
        )}
        onCommit={() => {
          const current = store.get();
          return onSave(capturePoolStash(current, populatedGroups(current)), moved);
        }}
        onClose={() => {
          if (store.get() === initial || window.confirm('Discard changes to this Stash layer?'))
            onClose();
        }}
      />
      {(editing === 'stash' || editing === 'aquifer') && (
        <PoolStashImport
          sources={sources}
          aquifer={editing === 'aquifer'}
          replacement={editing === 'aquifer' ? replacement?.entry.name : undefined}
          onClose={() => setEditing(undefined)}
          onImport={(source, links, move) => {
            if (editing === 'aquifer' && replacement) {
              const entry = findStashEntry(source.read(), links[0]);
              if (!entry) throw new Error('Select an available Aquifer account.');
              store.update((current) => replaceStashServer(current, replacement, entry));
              setEditing(undefined);
              setReplacement(undefined);
              return;
            }
            const transferred = transferStashEntries(store.get(), source.read(), links, move);
            store.update(() => transferred.stash);
            if (move)
              setMoved((current) =>
                new Map(current).set(
                  source.id,
                  capturePoolStash(transferred.source, populatedGroups(transferred.source)),
                ),
              );
            setEditing(undefined);
          }}
        />
      )}
      {editing === 'credentials' && (
        <PoolStashCredentials
          stash={store.stash}
          onClose={() => setEditing(undefined)}
          onSave={(edits) => {
            store.update((current) => applyStashCredentials(current, edits));
            setEditing(undefined);
          }}
        />
      )}
    </>
  );
}

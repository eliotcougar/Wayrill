import { lazy, Suspense, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import ConfigurationStash from '../components/ConfigurationStash';
import { parseStash, type Stash } from '../profiles/import';
import useStash from '../profiles/useStash';
import { newPoolStash, openGraphLayer, type PoolGraphStarter } from './graphLayer';
import { capturePoolGraph, capturePoolStash, type PoolBundle } from './model';

const GraphEditor = lazy(() => import('../App'));
const populatedGroups = (stash: Stash) =>
  stash.groups.filter((group) => group.entries.length).map((group) => group.id);

export function PoolGraphEditor({
  bundle,
  name,
  starter,
  onSave,
  onClose,
}: {
  bundle?: PoolBundle;
  name?: string;
  starter?: PoolGraphStarter;
  onSave: (bundle: PoolBundle) => Promise<void>;
  onClose: () => void;
}) {
  const [initial] = useState(() => {
    const layer = openGraphLayer(bundle, starter);
    if (name) layer.graph.name = name;
    return layer;
  });
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
              onSave: (graph, stash) =>
                onSave(capturePoolGraph(graph.name, graph, stash, populatedGroups(stash))),
            }}
          />
        </Suspense>
      </ReactFlowProvider>
    </div>
  );
}

export function PoolStashEditor({
  stash,
  onSave,
  onClose,
}: {
  stash?: string;
  onSave: (stash: string) => Promise<void>;
  onClose: () => void;
}) {
  const [initial] = useState(() => (stash ? parseStash(stash) : newPoolStash()));
  const store = useStash(initial);
  return (
    <ConfigurationStash
      store={store}
      layerMode
      onCommit={() => {
        const current = store.get();
        return onSave(capturePoolStash(current, populatedGroups(current)));
      }}
      onClose={() => {
        if (store.get() === initial || window.confirm('Discard changes to this Stash layer?'))
          onClose();
      }}
    />
  );
}

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useGraphEditor from './useGraphEditor';
import { compileRuntimeGraph } from './graph/runtime';
import { createPolicyExample } from './graph/policyExample';
import {
  emptyPolicySources,
  readPolicySources,
  refreshPolicySources,
  subscriptionSource,
} from './graph/policySources';
import { importProfiles, type Stash } from './profiles/import';
import { parseGraph } from './graph/model';
import { parseStash } from './profiles/import';
import { applyStashedProfile } from './profiles/graph';
import { factoryDefaults } from './graph/defaults';

// Editing/history cases use a fixed complex fixture, independent of first-run UX.
vi.mock('./graph/examples', async () => {
  const { createTrafficExample } = await import('./graph/example');
  const { enableDefaults } = await import('./graph/defaults');
  return { createProxyStarter: () => enableDefaults(createTrafficExample()) };
});

vi.mock('./useProtectedSlot', () => ({
  default: () => ({
    loading: false,
    ready: true,
    error: '',
    status: 'session',
  }),
}));

let root: Root;
let editor: ReturnType<typeof useGraphEditor>;
function Harness({
  stash,
  store,
  blocked = false,
}: {
  stash?: Stash;
  store?: Parameters<typeof useGraphEditor>[1];
  blocked?: boolean;
}) {
  editor = useGraphEditor(stash, store, blocked);
  return null;
}
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  await act(() => root.render(<Harness />));
});

it('flushes the latest library and linked graph when a refresh completes while edits are blocked', async () => {
  const group = importProfiles(
    JSON.stringify({ outbounds: [{ protocol: 'freedom', tag: 'direct' }] }),
  ).groups[0];
  let library: Stash = { format: 'wayrill.stash', version: 3, groups: [group] };
  const store = {
    get: () => library,
    update: vi.fn((transform: (s: Stash) => Stash) => (library = transform(library))),
  };
  await act(() => root.render(<Harness stash={library} store={store} />));
  const link = { groupId: group.id, entryId: group.entries[0].id };
  await act(() =>
    editor.loadGraph(
      applyStashedProfile(
        {
          name: 'Refresh on close',
          nodes: [],
          edges: [],
          defaults: factoryDefaults(),
        },
        group.entries[0],
        { x: 0, y: 0 },
        undefined,
        link,
      ),
    ),
  );
  library = {
    ...library,
    groups: library.groups.map((g) =>
      g.id !== group.id
        ? g
        : {
            ...g,
            entries: g.entries.map((entry) => ({
              ...entry,
              name: 'Refreshed Direct',
              profile: {
                ...entry.profile!,
                settings: {
                  ...entry.profile!.settings,
                  interface: 'New uplink',
                },
              },
            })),
          },
    ),
  };
  await act(() => root.render(<Harness stash={library} store={store} blocked />));
  expect(editor.graph.nodes[0].data.label).not.toBe('Refreshed Direct');
  // The Stash serializer must never fall back to an old history snapshot.
  expect(parseStash(editor.serializeStashForClose())).toEqual(library);
  let saved!: ReturnType<typeof parseGraph>;
  await act(() => {
    saved = parseGraph(editor.serializeForClose());
  });
  expect(saved.nodes[0].data.label).toBe('Refreshed Direct');
  expect(saved.nodes[0].data.settings.interface).toBe('New uplink');
  expect(parseStash(editor.serializeStashForClose())).toEqual(library);
});
afterEach(async () => {
  await act(() => root.unmount());
});

describe('layout history', () => {
  it('records subscription refresh as one undoable draft change while keeping manual selections and canvas structure', async () => {
    const sub = importProfiles('vless://public-a@a.example.net:443?security=tls#Public', 'Demo')
      .groups[0];
    const stash: Stash = {
      format: 'wayrill.stash',
      version: 3,

      groups: [sub],
    };
    const graph = createPolicyExample(),
      group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
    group.data.settings.selection = 'combined';
    group.data.settings.sources = JSON.stringify(
      refreshPolicySources(
        {
          ...emptyPolicySources(),
          manual: [{ type: 'node', nodeId: 'test-first' }],
          subscriptions: [subscriptionSource(sub)],
          fallback: { type: 'node', nodeId: 'test-block' },
        },
        stash,
      ),
    );
    await act(() => {
      root.render(<Harness stash={stash} />);
    });
    await act(() => editor.loadGraph(graph));
    const before = compileRuntimeGraph(editor.graph).config;
    const nextStash = structuredClone(stash);
    nextStash.groups[0].entries[0].profile!.settings.address = 'new.example.net';
    await act(() => root.render(<Harness stash={nextStash} />));
    expect(compileRuntimeGraph(editor.graph).config).not.toEqual(before);
    expect(editor.graph.nodes).toHaveLength(graph.nodes.length);
    expect(editor.graph.edges).toEqual(graph.edges);
    await act(() => editor.undo());
    expect(compileRuntimeGraph(editor.graph).config).toEqual(before);
    await act(() => editor.redo());
    expect(
      readPolicySources(editor.graph.nodes.find((n) => n.id === group.id)!.data).manual,
    ).toEqual([{ type: 'node', nodeId: 'test-first' }]);
  });

  it('records one transaction for multiple nodes moved across several drag frames', async () => {
    const ids = ['routes', 'dns'];
    const positions = ids.map((id) => editor.graph.nodes.find((n) => n.id === id)!.position);
    await act(() => editor.beginDrag());
    for (const offset of [16, 32, 48]) {
      await act(() =>
        editor.onNodesChange(
          ids.map((id, index) => ({
            id,
            type: 'position',
            dragging: true,
            position: { x: positions[index].x + offset, y: positions[index].y },
          })),
        ),
      );
    }
    expect(editor.canUndo).toBe(false);
    await act(() => editor.endDrag());
    expect(editor.canUndo).toBe(true);
    await act(() => editor.undo());
    expect(editor.canUndo).toBe(false);
    ids.forEach((id, index) =>
      expect(editor.graph.nodes.find((n) => n.id === id)!.position).toEqual(positions[index]),
    );
  });
});

describe('connection history', () => {
  it('reconnects one edge in one transaction; selection, no-op edits and invalid edits add no history', async () => {
    const old = editor.graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
    const before = editor.graph.edges.length;
    const draft = {
      source: 'socks',
      sourceHandle: 'data',
      target: 'block',
      targetHandle: 'in',
    };
    await act(() => editor.selectEdge(old.id));
    expect(editor.canUndo).toBe(false);
    await act(() =>
      expect(editor.saveConnection({ ...draft, target: 'observatory-missing' }, old.id)).toContain(
        'missing node',
      ),
    );
    expect(editor.canUndo).toBe(false);
    await act(() => expect(editor.saveConnection(draft, old.id)).toBeNull());
    expect(editor.graph.edges).toHaveLength(before);
    expect(editor.selectedEdges[0]).toMatchObject({
      id: old.id,
      target: 'block',
    });
    await act(() => editor.undo());
    expect(editor.graph.edges.find((e) => e.id === old.id)?.target).toBe('routes');
    expect(editor.canUndo).toBe(false);
    await act(() => editor.redo());
    await act(() => editor.saveConnection(draft, old.id));
    await act(() => editor.undo());
    expect(editor.graph.edges.find((e) => e.id === old.id)?.target).toBe('routes');
    expect(editor.canUndo).toBe(false);
  });
  it('rechecks queued edits so two additions cannot occupy the same output', async () => {
    const old = editor.graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
    await act(() => editor.selectEdge(old.id));
    await act(() => editor.removeSelected());
    const before = editor.graph.edges.length;
    await act(() => {
      editor.saveConnection({
        source: 'socks',
        sourceHandle: 'data',
        target: 'block',
        targetHandle: 'in',
      });
      editor.saveConnection({
        source: 'socks',
        sourceHandle: 'data',
        target: 'direct',
        targetHandle: 'in',
      });
    });
    expect(editor.graph.edges).toHaveLength(before + 1);
    expect(
      editor.graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')?.target,
    ).toBe('block');
  });
});

it('undoes an entire focused port edit instead of one digit and keeps redo intact', async () => {
  const id = editor.graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!.id;
  const port = () => Number(editor.graph.nodes.find((n) => n.id === id)!.data.settings.port);
  const before = port();
  await act(() => editor.beginFieldEdit());
  for (const value of [4, 41, 418, 4180])
    await act(() => {
      const node = editor.graph.nodes.find((n) => n.id === id)!;
      editor.updateNode(id, {
        settings: { ...node.data.settings, port: value },
      });
    });
  await act(() => editor.undo());
  expect(port()).toBe(before);
  await act(() => editor.redo());
  expect(port()).toBe(4180);
});

it('freezes edits, imports, keyboard node movement and history during a lifecycle transition', async () => {
  await act(() => editor.change((g) => ({ ...g, name: 'Before startup' })));
  const before = editor.serialize();
  await act(() => root.render(<Harness blocked />));
  await act(() => {
    editor.change((g) => ({ ...g, name: 'Changed while blocked' }));
    editor.onNodesChange([{ id: 'routes', type: 'position', position: { x: 900, y: 800 } }]);
    editor.updateNode('routes', { label: 'Changed' });
    editor.removeSelected();
    editor.undo();
    editor.redo();
    editor.loadGraph({ name: 'Late import', nodes: [], edges: [] });
  });
  expect(editor.serialize()).toBe(before);
  await act(() => root.render(<Harness />));
  await act(() => editor.change((g) => ({ ...g, name: 'After startup' })));
  expect(editor.graph.name).toBe('After startup');
});

it('restores graph and stash as one Undo/Redo transaction and rejects restoration while blocked', async () => {
  let library: Stash = { format: 'wayrill.stash', version: 3, groups: [] };
  const store = {
    get: () => library,
    update: vi.fn((transform: (s: Stash) => Stash) => (library = transform(library))),
  };
  await act(() => root.render(<Harness stash={library} store={store} />));
  const before = editor.serialize();
  const previousLibrary = library;
  const restoredLibrary: Stash = {
    ...library,
    groups: importProfiles('socks://127.0.0.1:1080#Restored').groups,
  };
  await act(() =>
    editor.restoreWorkspace(
      { name: 'Restored graph', defaults: factoryDefaults(), nodes: [], edges: [] },
      restoredLibrary,
    ),
  );
  expect(editor.graph.name).toBe('Restored graph');
  expect(library).toBe(restoredLibrary);
  await act(() => editor.undo());
  expect(editor.serialize()).toBe(before);
  expect(library).toBe(previousLibrary);
  await act(() => editor.redo());
  expect(editor.graph.name).toBe('Restored graph');
  expect(library).toBe(restoredLibrary);
  await act(() => root.render(<Harness stash={library} store={store} blocked />));
  store.update.mockClear();
  expect(() =>
    editor.restoreWorkspace({ name: 'Must not apply', nodes: [], edges: [] }, previousLibrary),
  ).toThrow('not ready');
  expect(store.update).not.toHaveBeenCalled();
  expect(editor.graph.name).toBe('Restored graph');
});
it('restores viewports only when Undo or Redo crosses a whole-graph replacement', async () => {
  let library: Stash = { format: 'wayrill.stash', version: 3, groups: [] };
  const store = {
    get: () => library,
    update: (transform: (s: Stash) => Stash) => (library = transform(library)),
  };
  await act(() => root.render(<Harness stash={library} store={store} />));
  const before = { x: 100, y: 80, zoom: 0.5 },
    after = { x: -400, y: 50, zoom: 0.8 };
  await act(() => editor.setViewport(before));
  await act(() =>
    editor.restoreWorkspace(
      { name: 'Restored', defaults: factoryDefaults(), nodes: [], edges: [], viewport: after },
      library,
      true,
    ),
  );
  const version = editor.loadVersion;
  await act(() => editor.change((g) => ({ ...g, name: 'Edited' })));
  await act(() => editor.undo());
  expect(editor.graph.name).toBe('Restored');
  expect(editor.loadVersion).toBe(version);
  await act(() => editor.undo());
  expect(editor.graph.viewport).toEqual(before);
  expect(editor.loadVersion).toBe(version + 1);
  await act(() => editor.redo());
  expect(editor.graph.viewport).toEqual(after);
  expect(editor.loadVersion).toBe(version + 2);
});

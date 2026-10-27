import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { commitEditorDraft } from './editorDraft';
import { editGraphNode } from './nodeEditing';
import { factoryDefaults } from './defaults';
import { applyStashedProfile } from '../profiles/graph';
import { snapshotGraphEntry } from '../profiles/workspace';
import { createPolicyExample } from './policyExample';
import type { GraphState } from './types';

const fixture = (): GraphState => ({
  name: 'Editor',
  nodes: [makeNode('socks-outbound', { x: 0, y: 0 }, 'outbound')],
  edges: [],
  defaults: factoryDefaults(),
});

it('preserves refreshed credentials when a modal only edits its name', () => {
  const before = fixture();
  const draft = editGraphNode(before, 'outbound', { label: 'My server' });
  const latest = editGraphNode(before, 'outbound', {
    settings: { ...before.nodes[0].data.settings, address: 'updated.example', password: 'new' },
  });
  const saved = commitEditorDraft(before, draft, latest);
  expect(saved.nodes[0].data).toMatchObject({
    label: 'My server',
    settings: { address: 'updated.example', password: 'new' },
  });
  expect(latest.nodes[0].data.label).toBe(before.nodes[0].data.label);
});

it('rejects a true same-field conflict without changing either draft or current graph', () => {
  const before = fixture();
  const draft = editGraphNode(before, 'outbound', {
    settings: { ...before.nodes[0].data.settings, address: 'mine.example' },
  });
  const latest = editGraphNode(before, 'outbound', {
    settings: { ...before.nodes[0].data.settings, address: 'provider.example' },
  });
  expect(() => commitEditorDraft(before, draft, latest)).toThrow(
    /changed while this editor was open/i,
  );
  expect(draft.nodes[0].data.settings.address).toBe('mine.example');
  expect(latest.nodes[0].data.settings.address).toBe('provider.example');
});

it.each(['removed', 'replaced'] as const)('rejects an edited node that was %s', (change) => {
  const before = fixture();
  const draft = editGraphNode(before, 'outbound', { label: 'My server' });
  const latest =
    change === 'removed'
      ? { ...before, nodes: [] }
      : { ...before, nodes: [makeNode('direct-outbound', { x: 0, y: 0 }, 'outbound')] };
  expect(() => commitEditorDraft(before, draft, latest)).toThrow(
    /changed while this editor was open/i,
  );
});

it('retains newly required observation topology and removes obsolete observation topology', () => {
  const example = createPolicyExample();
  const group = example.nodes.find((node) => node.data.kind === 'policy-group')!;
  const entry = snapshotGraphEntry(example, group);
  const unobserved = editGraphNode(example, group.id, {
    settings: { ...group.data.settings, strategy: 'roundRobin', observe: false },
  });
  const before = {
    ...unobserved,
    nodes: unobserved.nodes.filter((node) => node.data.kind !== 'observatory'),
    edges: unobserved.edges.filter((edge) => edge.sourceHandle !== 'observation'),
  };
  const draft = editGraphNode(before, group.id, { label: 'My policy' });
  const latest = applyStashedProfile(before, entry, { x: 0, y: 0 }, group.id);
  expect(latest.nodes.some((node) => node.data.kind === 'observatory')).toBe(true);
  expect(latest.edges.some((edge) => edge.sourceHandle === 'observation')).toBe(true);
  const saved = commitEditorDraft(before, draft, latest);
  expect(saved.nodes.find((node) => node.id === group.id)?.data).toMatchObject({
    label: 'My policy',
    settings: { observe: true },
  });
  expect(saved.nodes.filter((node) => node.id !== group.id)).toEqual(
    latest.nodes.filter((node) => node.id !== group.id),
  );
  expect(saved.edges).toEqual(latest.edges);
  const removed = commitEditorDraft(latest, { ...latest, name: 'Next' }, before);
  expect(removed.nodes).toEqual(before.nodes);
  expect(removed.edges).toEqual(before.edges);
});

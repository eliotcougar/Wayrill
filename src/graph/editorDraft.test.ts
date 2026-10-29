import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { commitEditorDraft } from './editorDraft';
import { editGraphNode } from './nodeEditing';
import { factoryDefaults } from './defaults';
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

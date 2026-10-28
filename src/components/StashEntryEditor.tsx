import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import Inspector from './Inspector';
import ProtocolEditor from './ProtocolEditor';
import useModalDialog from './useModalDialog';
import { factoryDefaults, resolveGraph } from '../graph/defaults';
import { editGraphNode } from '../graph/nodeEditing';
import { stashEditorNode, snapshotGraphEntry } from '../profiles/workspace';
import { checkPrepared } from '../profiles/preparedPreviewClient';
import { parseEntry, type StashEntry } from '../profiles/import';
import type { GraphState, RuleNodeData } from '../graph/types';
import { boundedText } from '../text';

export default function StashEntryEditor({
  entry,
  graph,
  onSave,
  onClose,
}: {
  entry: StashEntry;
  graph?: GraphState;
  onSave: (entry: StashEntry) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog);
  const [draft, setDraft] = useState(() => {
    const context = graph ?? {
      name: 'Stash editor',
      nodes: [],
      edges: [],
      defaults: factoryDefaults(),
    };
    if (!entry.profile && !entry.draft) return null;
    const node = stashEditorNode(entry, context, 'stash-edit-' + crypto.randomUUID());
    return { ...context, nodes: [...context.nodes, node], editingId: node.id };
  });
  const [name, setName] = useState(entry.name),
    [raw, setRaw] = useState(entry.raw),
    [protocolOpen, setProtocolOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const node = draft?.nodes.find((n) => n.id === draft.editingId);
  const update = (_id: string, data: Partial<RuleNodeData>) =>
    setDraft(
      (current) =>
        current && {
          ...resolveGraph(editGraphNode(current, current.editingId, data)),
          editingId: current.editingId,
        },
    );
  const close = () => {
    operation.current?.abort();
    onClose();
  };
  async function save() {
    setError('');
    setBusy(true);
    const controller = new AbortController();
    operation.current = controller;
    try {
      let next: StashEntry;
      if (draft && node) {
        if (!node.data.label.trim()) throw new Error('Enter an outbound name.');
        await checkPrepared(draft, node, controller.signal);
        controller.signal.throwIfAborted();
        next = snapshotGraphEntry(draft, node, entry.id, entry);
        if (!next.profile) throw new Error(next.problem);
      } else {
        if (!name.trim()) throw new Error('Enter an outbound name.');
        next = { ...entry, ...parseEntry(raw), id: entry.id, name: name.trim() };
      }
      onSave(next);
      onClose();
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        operation.current = null;
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window stash-entry-editor"
      aria-labelledby="stash-entry-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={close}
    >
      <div className="rule-editor-titlebar">
        <h2 id="stash-entry-title">Edit outbound</h2>
        <button className="icon-button" aria-label="Close outbound editor" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <div className="stash-entry-editor-body" inert={busy || undefined}>
        {node && draft ? (
          <Inspector
            libraryEdit
            graph={draft}
            node={node}
            diagnostics={[]}
            selectedCount={1}
            onUpdate={update}
            onEdit={() => setProtocolOpen(true)}
            onClose={close}
            onDelete={() => {}}
            onSelect={() => {}}
            onConnect={() => {}}
            onSelectConnection={() => {}}
            onEditConnection={() => {}}
            onShowConnection={() => {}}
          />
        ) : (
          <>
            <label className="editor-field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(boundedText(e.target.value, 128))} />
            </label>
            <label className="editor-field">
              <span>Source configuration</span>
              <textarea rows={12} value={raw} onChange={(e) => setRaw(e.target.value)} />
            </label>
          </>
        )}
      </div>
      {error && (
        <div role="alert" className="notice notice--error">
          {error}
        </div>
      )}
      <div className="rule-editor-footer">
        <span>{busy ? 'Checking…' : ''}</span>
        <button className="secondary-button" onClick={close}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={busy || !(node?.data.label.trim() ?? name.trim())}
          onClick={() => void save()}
        >
          Save to Stash
        </button>
      </div>
      {protocolOpen && node && (
        <ProtocolEditor
          node={node}
          defaults={draft?.defaults}
          onApply={update}
          onClose={() => setProtocolOpen(false)}
        />
      )}
    </dialog>
  );
}

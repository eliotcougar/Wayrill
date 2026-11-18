import { useState } from 'react';
import Dialog from '../components/Dialog';
import type { GraphState } from '../graph/types';
import type { Stash } from '../profiles/import';
import { errorText } from '../serviceClient';
import { capturePoolGraph, capturePoolStash, poolInputs } from './model';
import { sendPoolExport } from './handoff';
import './pool.css';

export default function PoolExport({
  mode,
  graph,
  stash,
  onClose,
}: {
  mode: 'graph' | 'stash';
  graph: GraphState;
  stash: Stash;
  onClose: () => void;
}) {
  const inputs = mode === 'graph' ? poolInputs(graph) : [];
  const [name, setName] = useState(mode === 'graph' ? graph.name : 'Stash');
  const [inputIds, setInputIds] = useState(inputs.map((input) => input.id));
  const [groups, setGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await sendPoolExport(
        mode === 'graph'
          ? {
              kind: 'graph',
              name: name.trim(),
              bundle: capturePoolGraph(name, graph, stash, groups, inputIds),
            }
          : { kind: 'stash', name: name.trim(), stash: capturePoolStash(stash, groups) },
      );
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={mode === 'graph' ? 'Export graph to Pool' : 'Export Stash layer to Pool'}
      onClose={onClose}
      busy={busy}
      className="pool-dialog"
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={
              busy || !name.trim() || (mode === 'graph' ? !inputIds.length : !groups.length)
            }
            onClick={() => void submit()}
          >
            Send to Wayrill Pool
          </button>
        </>
      }
    >
      <label className="editor-field">
        <span>{mode === 'graph' ? 'Graph layer name' : 'Stash layer name'}</span>
        <input
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {mode === 'graph' && (
        <fieldset>
          <legend>Convert to Inbound Placeholders</legend>
          {!inputs.length && <p>Connect an inbound to the graph first.</p>}
          {inputs.map((node) => (
            <label className="item-row check-control" key={node.id}>
              <input
                type="checkbox"
                checked={inputIds.includes(node.id)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setInputIds((current) =>
                    checked ? [...current, node.id] : current.filter((id) => id !== node.id),
                  );
                }}
              />
              {node.data.label}
            </label>
          ))}
        </fieldset>
      )}
      <h3 id="pool-groups">{mode === 'graph' ? 'Additional Stash groups' : 'Stash groups'}</h3>
      <div className="item-list pool-stash-groups" role="group" aria-labelledby="pool-groups">
        {stash.groups.map((group) => (
          <label key={group.id} className="item-row check-control">
            <input
              type="checkbox"
              checked={groups.includes(group.id)}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setGroups((current) =>
                  checked ? [...current, group.id] : current.filter((id) => id !== group.id),
                );
              }}
            />
            {group.name}
          </label>
        ))}
      </div>
      <p className="field-help">
        {mode === 'graph'
          ? 'Includes the graph’s filters and required Stash entries. If a Proxy or TUN placeholder is missing, it starts with an existing entry path.'
          : 'Includes the selected groups and their dependencies. Subscription URLs and download headers stay in Wayrill.'}
      </p>
      {error && (
        <p role="alert" className="notice notice--error">
          {error}
        </p>
      )}
    </Dialog>
  );
}

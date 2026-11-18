import { useState } from 'react';
import Dialog from '../components/Dialog';
import type { GraphState, PoolGraphLink } from '../graph/types';
import { errorText } from '../serviceClient';
import { linkedFilterKind } from './graphLinks';
import type { PoolLayer } from './layers';

export default function PoolGraphLinks({
  graph,
  layers,
  onClose,
  onApply,
}: {
  graph: GraphState;
  layers: readonly PoolLayer[];
  onClose: () => void;
  onApply: (links: PoolGraphLink[]) => void;
}) {
  const nodes = graph.nodes.filter((node) => linkedFilterKind(node.data.kind));
  const [links, setLinks] = useState(() =>
    (graph.poolLayerLinks ?? []).filter(
      ({ target }) => !target || nodes.some(({ id }) => id === target),
    ),
  );
  const [problem, setProblem] = useState('');
  const stashes = layers.filter(({ data }) => data.kind === 'stash');
  return (
    <Dialog
      title="Linked layers"
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={() => {
              try {
                onApply(links);
              } catch (reason) {
                setProblem(errorText(reason));
              }
            }}
          >
            Apply links
          </button>
        </>
      }
    >
      <p className="field-help">
        Linked layers are part of this graph for everyone who receives it. Update their contents in
        Layers, then publish affected deliveries.
      </p>
      <fieldset className="pool-assignments">
        <legend>Traffic and DNS filters</legend>
        {!nodes.length && <p>Add a Traffic or DNS filter to the graph to link a filter layer.</p>}
        {nodes.map(({ id, data }) => {
          const selected = links.find(({ target }) => target === id)?.id ?? '';
          const choices = layers.filter((layer) => layer.data.kind === linkedFilterKind(data.kind));
          return (
            <label className="editor-field" key={id}>
              <span>{data.label}</span>
              <select
                value={selected}
                onChange={(event) => {
                  const source = event.currentTarget.value;
                  setLinks((current) => [
                    ...current.filter(({ target }) => target !== id),
                    ...(source ? [{ id: source, target: id }] : []),
                  ]);
                }}
              >
                <option value="">Use this node’s rules</option>
                {selected && !choices.some(({ id }) => id === selected) && (
                  <option value={selected}>Layer unavailable</option>
                )}
                {choices.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
        {!!nodes.length && <p className="field-help">Connect any new outputs on the canvas.</p>}
      </fieldset>
      <fieldset className="pool-assignments">
        <legend>Stashes</legend>
        {!stashes.length && (
          <p>Create a Stash layer to make its entries available in this graph.</p>
        )}
        {stashes.map(({ id, name }) => (
          <label className="check-control" key={id}>
            <input
              type="checkbox"
              checked={links.some((link) => !link.target && link.id === id)}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setLinks((current) =>
                  checked
                    ? [...current, { id }]
                    : current.filter((link) => link.target || link.id !== id),
                );
              }}
            />
            {name}
          </label>
        ))}
        {links
          .filter(({ id, target }) => !target && !stashes.some((layer) => layer.id === id))
          .map(({ id }) => (
            <button
              className="secondary-button"
              key={id}
              onClick={() =>
                setLinks((current) => current.filter((link) => link.id !== id || link.target))
              }
            >
              Remove unavailable Stash link
            </button>
          ))}
      </fieldset>
      {problem && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

import { useState } from 'react';
import Dialog from '../components/Dialog';
import type { PoolTransfer } from './layers';
import { usesLayer } from './management';
import type { Publisher } from './publisher';
import { isDeviceLayer } from './deviceLayers';

export default function PoolLayerAssignments({
  pool,
  id,
  layer,
  busy,
  failure,
  onClose,
  onSave,
}: {
  pool: Publisher;
  id: string;
  layer: PoolTransfer;
  busy: boolean;
  failure: string;
  onClose: () => void;
  onSave: (users: ReadonlyMap<string, string>) => void;
}) {
  const [initial] = useState(
    () =>
      new Map(
        pool.members
          .filter((member) => usesLayer(member, id))
          .map((member) => [
            member.id,
            member.assignments?.find((item) => item.id === id)?.target ?? '',
          ]),
      ),
  );
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const visible = pool.members.filter((member) => member.name.toLowerCase().includes(search));
  const allVisible = visible.every(({ id }) => selected.has(id));
  function setVisible(assigned: boolean) {
    setSelected((current) => {
      const next = new Map(current);
      for (const { id } of visible) {
        if (!assigned) next.delete(id);
        else if (!next.has(id)) next.set(id, initial.get(id) ?? '');
      }
      return next;
    });
  }
  const set = (member: string, assigned: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (assigned) next.set(member, initial.get(member) ?? '');
      else next.delete(member);
      return next;
    });
  return (
    <Dialog
      title={`Assign ${layer.name}`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || !pool.members.length}
            onClick={() => onSave(selected)}
          >
            Save assignments
          </button>
        </>
      }
    >
      <p className="field-help">
        {isDeviceLayer(layer)
          ? 'Select who can use this layer. Each subscriber chooses whether to apply it.'
          : 'Select who can use this layer. Set each user’s defaults in Edit delivery.'}
      </p>
      {!!pool.members.length && (
        <div className="pool-list-controls">
          <input
            type="search"
            className="text-control pool-search"
            aria-label="Find users to assign"
            placeholder="Find users…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <button
            className="secondary-button"
            disabled={busy || !visible.length || allVisible}
            onClick={() => setVisible(true)}
          >
            Select shown
          </button>
          <button
            className="secondary-button"
            disabled={busy || !visible.some(({ id }) => selected.has(id))}
            onClick={() => setVisible(false)}
          >
            Clear shown
          </button>
          <span className="field-help" role="status">
            {selected.size} assigned
          </span>
        </div>
      )}
      <div className="item-list">
        {visible.map((member) => {
          const assigned = selected.has(member.id);
          return (
            <div className="item-row pool-assignment-row" key={member.id}>
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={assigned}
                  disabled={busy}
                  onChange={(event) => set(member.id, event.currentTarget.checked)}
                />
                <span>{member.name}</span>
              </label>
            </div>
          );
        })}
      </div>
      {!pool.members.length && <p>Add users in the Users tab to assign this layer.</p>}
      {!!pool.members.length && !visible.length && <p>No matching users.</p>}
      {failure && (
        <p className="notice notice--error" role="alert">
          {failure}
        </p>
      )}
    </Dialog>
  );
}

import { useState } from 'react';
import type { NodeKind, StashLink } from '../graph/types';
import type { PoolOptions } from './delivery';

const ceiling = 100;

export default function PoolOutboundChoice({
  name,
  accepts,
  entries,
  value,
  onChange,
}: {
  name: string;
  accepts: NodeKind[];
  entries: PoolOptions['entries'];
  value?: StashLink;
  onChange: (link?: StashLink) => void;
}) {
  const [query, setQuery] = useState('');
  const text = query.trim().toLowerCase();
  const compatible = new Set(accepts);
  const selected =
    value &&
    entries.find((item) => item.groupId === value.groupId && item.entryId === value.entryId);
  const matches = entries.filter(
    (item) => compatible.has(item.kind) && item.name.toLowerCase().includes(text),
  );
  const shown = matches.slice(0, ceiling);
  if (selected && !shown.includes(selected)) shown.unshift(selected);
  const key = (item: StashLink) => JSON.stringify([item.groupId, item.entryId]);
  return (
    <fieldset>
      <legend>{name}</legend>
      {entries.length > ceiling && (
        <label className="editor-field">
          <span>Find a Stash outbound</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      )}
      <label className="editor-field">
        <span>Outbound</span>
        <select
          value={selected ? key(selected) : ''}
          onChange={(event) => {
            const item = shown.find((item) => key(item) === event.currentTarget.value);
            onChange(item && { groupId: item.groupId, entryId: item.entryId });
          }}
        >
          <option value="">Use graph outbound</option>
          {shown.map((item) => (
            <option key={key(item)} value={key(item)}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {matches.length > ceiling && (
        <small className="field-help">
          Showing the first {ceiling} matches. Refine the search to see another outbound.
        </small>
      )}
    </fieldset>
  );
}

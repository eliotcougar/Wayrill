import { Search } from 'lucide-react';
import NodeLibraryItem from '@wayrill/ui/NodeLibraryItem';
import { nodeLibrary } from './remoteCreation';

export default function RemoteNodeLibrary({
  query,
  onQuery,
  onAdd,
  disabled,
}: {
  query: string;
  onQuery: (value: string) => void;
  onAdd: (id: string) => void;
  disabled: boolean;
}) {
  const entries = nodeLibrary.filter((entry) =>
    `${entry.title} ${entry.group} ${entry.protocol ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="node-library" aria-label="Node library">
      <label className="compact-controls search-control">
        <Search size={15} aria-hidden="true" />
        <input
          autoComplete="off"
          id="node-search"
          aria-label="Search node library"
          placeholder="Find a node…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <div className="node-library-items">
        {(['Inbounds', 'Rules & filters', 'Outbounds', 'User sets'] as const).map((group) => {
          const items = entries.filter((entry) => entry.group === group);
          return items.length ? (
            <section key={group} className="palette-group">
              <h3>{group}</h3>
              {items.map((entry) => (
                <NodeLibraryItem
                  key={entry.id}
                  kind={entry.kind}
                  label={entry.title}
                  category={entry.category}
                  disabled={disabled}
                  draggable={!disabled}
                  title="Click to add, or drag onto the graph"
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-wayrill-node', entry.id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  aria-label={`Add ${entry.title} (${group})`}
                  onClick={() => onAdd(entry.id)}
                />
              ))}
            </section>
          ) : null;
        })}
        {!entries.length && (
          <p className="empty-state empty-state--inline">No nodes match “{query}”.</p>
        )}
      </div>
    </section>
  );
}

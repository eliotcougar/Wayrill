import { ArrowDownToLine, ArrowUpFromLine, Filter, Plus, Search, Users } from 'lucide-react';
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
      <div className="search-control">
        <Search size={15} />
        <input
          className="text-control"
          id="node-search"
          aria-label="Search node library"
          placeholder="Search nodes"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <div className="node-library-items">
        {(['Inbounds', 'Rules & filters', 'Outbounds', 'User sets'] as const).map((group) => {
          const items = entries.filter((entry) => entry.group === group);
          const Icon =
            group === 'Inbounds'
              ? ArrowDownToLine
              : group === 'Outbounds'
                ? ArrowUpFromLine
                : group === 'User sets'
                  ? Users
                  : Filter;
          return items.length ? (
            <section key={group} className="node-library-group">
              <h3>{group}</h3>
              {items.map((entry) => (
                <button
                  key={entry.id}
                  className={`secondary-button node-library-item ${group === 'Inbounds' ? 'inbound' : group === 'Outbounds' ? 'outbound' : group === 'User sets' ? 'users' : 'filter'}`}
                  disabled={disabled}
                  draggable={!disabled}
                  title="Click to add, or drag onto the graph"
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-wayrill-node', entry.id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  aria-label={`Add ${entry.title} ${group === 'Inbounds' ? 'inbound' : group === 'Outbounds' ? 'outbound' : 'node'}`}
                  onClick={() => onAdd(entry.id)}
                >
                  <Icon size={17} />
                  <span>{entry.title}</span>
                  <Plus size={14} />
                </button>
              ))}
            </section>
          ) : null;
        })}
        {!entries.length && <p className="muted">No matching node types</p>}
      </div>
    </section>
  );
}

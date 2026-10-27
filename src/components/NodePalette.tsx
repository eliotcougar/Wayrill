import { GripVertical, Search } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import usePointerDrag, { type DragPoint } from './usePointerDrag';
import { availableNodes } from '../graph/catalog';
import type { NodeDefinition, NodeKind } from '../graph/types';
import NodeIcon from './NodeIcon';

export default function NodePalette({
  onAdd,
  onDrop,
  items = availableNodes,
}: {
  onAdd: (kind: NodeKind) => void;
  onDrop: (kind: NodeKind, point: DragPoint) => void;
  items?: NodeDefinition[];
}) {
  const [query, setQuery] = useState('');
  const drag = usePointerDrag(onDrop);
  const dragged = items.find((item) => item.kind === drag.preview?.value);
  const filtered = items.filter((item) =>
    `${item.title} ${item.group} ${item.summary}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <aside className="node-palette" aria-label="Node library">
      <div className="palette-search">
        <Search size={15} aria-hidden="true" />
        <input
          autoComplete="off"
          id="node-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a node…"
          aria-label="Search node library"
        />
      </div>
      {(['Local capture', 'Inbounds', 'Rules & filters', 'Outbounds'] as const).map((group) => {
        const entries = filtered.filter((item) => item.group === group);
        return (
          !!entries.length && (
            <section className="palette-group" key={group}>
              <h3>{group}</h3>
              {entries.map((item) => (
                <button
                  key={item.kind}
                  className={`palette-item category-${item.category}`}
                  onPointerDown={(event) => drag.start(event, item.kind)}
                  onPointerMove={drag.move}
                  onPointerUp={drag.end}
                  onPointerCancel={drag.cancel}
                  onLostPointerCapture={drag.cancel}
                  onClick={() => {
                    if (!drag.consumeClick()) onAdd(item.kind);
                  }}
                  aria-label={`Add ${item.title} (${group})`}
                  title={item.summary}
                >
                  <span className="palette-icon">
                    <NodeIcon kind={item.kind} size={17} />
                  </span>
                  <span className="palette-item-copy">
                    <strong>{item.title}</strong>
                  </span>
                  <GripVertical className="palette-grip" size={14} aria-hidden="true" />
                </button>
              ))}
            </section>
          )
        );
      })}
      {drag.preview &&
        dragged &&
        createPortal(
          <div
            className="palette-drag-preview"
            aria-hidden="true"
            style={{ left: drag.preview.point.x + 12, top: drag.preview.point.y + 12 }}
          >
            <NodeIcon kind={dragged.kind} size={17} /> {dragged.title}
          </div>,
          document.body,
        )}
      {!filtered.length && <p className="empty-search">No nodes match “{query}”.</p>}
    </aside>
  );
}

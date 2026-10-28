import { GripVertical } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import usePointerDrag, { type DragPoint } from './usePointerDrag';

interface OutputIdentity {
  id: string;
  name: string;
}

export default function OutputList<T extends OutputIdentity>({
  outputs,
  label,
  onMove,
  rowClass,
  children,
}: {
  outputs: T[];
  label: string;
  onMove: (id: string, to: number) => void;
  rowClass?: (output: T) => string;
  children: (output: T, index: number) => ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const targetAt = (point: DragPoint) => {
    const bounds = list.current?.getBoundingClientRect();
    const viewport = list.current?.closest('.output-editor')?.getBoundingClientRect();
    if (
      !bounds ||
      point.x < bounds.left ||
      point.x > bounds.right ||
      point.y < Math.max(bounds.top, viewport?.top ?? bounds.top) ||
      point.y > Math.min(bounds.bottom, viewport?.bottom ?? bounds.bottom)
    )
      return -1;
    let nearest = -1,
      distance = Infinity;
    outputs.forEach((output, index) => {
      const row = rows.current.get(output.id)?.getBoundingClientRect();
      if (!row) return;
      const candidate = Math.abs(point.y - (row.top + row.bottom) / 2);
      if (candidate < distance) {
        distance = candidate;
        nearest = index;
      }
    });
    return nearest;
  };
  const move = (id: string, to: number) => {
    const from = outputs.findIndex((o) => o.id === id);
    if (from < 0 || to < 0 || to >= outputs.length || from === to) return;
    focusAfterMove.current = id;
    onMove(id, to);
    setAnnouncement(
      `${outputs[from].name || 'Unnamed output'} moved to position ${to + 1} of ${outputs.length}.`,
    );
  };
  const drag = usePointerDrag<string>((id, point) => move(id, targetAt(point)));
  const from = outputs.findIndex((o) => o.id === drag.preview?.value);
  const target = drag.preview ? targetAt(drag.preview.point) : -1;
  const order = outputs.map((o) => o.id).join(',');
  useLayoutEffect(() => {
    if (!focusAfterMove.current) return;
    const handle = handles.current.get(focusAfterMove.current);
    handle?.focus();
    handle?.scrollIntoView?.({ block: 'nearest' });
    focusAfterMove.current = null;
  }, [order]);

  return (
    <div
      ref={list}
      className="compact-controls output-editor-list"
      role="group"
      aria-label={label}
      data-diagnostic-field="outputs"
    >
      {outputs.map((output, index) => (
        <div
          key={output.id}
          data-diagnostic-output={output.id}
          ref={(row) => {
            if (row) rows.current.set(output.id, row);
            else rows.current.delete(output.id);
          }}
          className={[
            'output-editor-row',
            rowClass?.(output),
            drag.preview?.value === output.id && 'is-dragging',
            index === target &&
              target !== from &&
              (target > from ? 'output-drop-after' : 'output-drop-before'),
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <button
            type="button"
            className="icon-button output-drag-handle"
            ref={(handle) => {
              if (handle) handles.current.set(output.id, handle);
              else handles.current.delete(output.id);
            }}
            aria-label={`Reorder output ${output.name || 'Unnamed output'}`}
            title="Drag to reorder · Alt+↑/↓"
            onClick={(event) => {
              if (drag.consumeClick()) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (!event.altKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
                return;
              event.preventDefault();
              event.stopPropagation();
              move(
                output.id,
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? outputs.length - 1
                    : Math.max(
                        0,
                        Math.min(outputs.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)),
                      ),
              );
            }}
            onPointerDown={(event) => drag.start(event, output.id)}
            onPointerMove={(event) => {
              drag.move(event);
              const scroller = list.current?.closest<HTMLElement>('.output-editor');
              const bounds = scroller?.getBoundingClientRect();
              if (drag.preview && scroller && bounds) {
                if (event.clientY < bounds.top + 28) scroller.scrollTop -= 16;
                else if (event.clientY > bounds.bottom - 28) scroller.scrollTop += 16;
              }
            }}
            onPointerUp={drag.end}
            onPointerCancel={drag.cancel}
            onLostPointerCapture={drag.cancel}
          >
            <GripVertical size={16} aria-hidden="true" />
          </button>
          {children(output, index)}
        </div>
      ))}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

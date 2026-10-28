import { GripVertical, AlertCircle } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import usePointerDrag, { type DragPoint } from './usePointerDrag';

export function moveEntry<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

export interface OrderedEntry {
  id: string;
  name: string;
  enabled: boolean;
  summary: string;
  destination?: string;
  notice?: string;
}

export function OrderedEntries({
  entries,
  selected,
  onSelect,
  onMove,
  label,
  empty,
  compact = false,
}: {
  entries: OrderedEntry[];
  selected: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, to: number) => void;
  label: string;
  empty: string;
  compact?: boolean;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const list = useRef<HTMLDivElement>(null);
  const targetAt = (point: DragPoint) => {
    const bounds = list.current?.getBoundingClientRect();
    if (
      !bounds ||
      point.x < bounds.left ||
      point.x > bounds.right ||
      point.y < bounds.top ||
      point.y > bounds.bottom
    )
      return -1;
    return entries.findIndex((entry) => {
      const row = buttons.current.get(entry.id)?.getBoundingClientRect();
      return row && point.y >= row.top && point.y <= row.bottom;
    });
  };
  const drag = usePointerDrag<string>((id, point) => {
    const to = targetAt(point);
    if (to >= 0 && entries.some((entry) => entry.id === id)) {
      onSelect(id);
      onMove(id, to);
    }
  });
  const dropIndex = drag.preview ? targetAt(drag.preview.point) : -1;

  const tabStop = entries.some((entry) => entry.id === selected) ? selected : entries[0]?.id;
  const order = entries.map((e) => e.id).join(',');
  const previous = useRef(order);
  useLayoutEffect(() => {
    if (previous.current !== order && selected) {
      const button = buttons.current.get(selected);
      button?.focus();
      button?.scrollIntoView?.({ block: 'nearest' });
    }
    previous.current = order;
  }, [order, selected]);
  return (
    <div
      ref={list}
      className={`rule-list${compact ? ' compact-rule-list' : ''}`}
      role="group"
      aria-label={label}
    >
      {entries.map((entry, index) => (
        <button
          ref={(el) => {
            if (el) buttons.current.set(entry.id, el);
            else buttons.current.delete(entry.id);
          }}
          key={entry.id}
          tabIndex={tabStop === entry.id ? 0 : -1}
          aria-pressed={selected === entry.id}
          className={`rule-list-item${selected === entry.id ? ' selected' : ''}${!entry.enabled ? ' disabled-rule' : ''}${dropIndex === index ? ' rule-drop-target' : ''}`}
          title={[entry.summary, entry.notice, !entry.enabled && 'Disabled']
            .filter(Boolean)
            .join(' · ')}
          onClick={() => {
            if (!drag.consumeClick()) onSelect(entry.id);
          }}
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const to =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? entries.length - 1
                  : Math.max(
                      0,
                      Math.min(entries.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)),
                    );
            if (event.altKey) onMove(entry.id, to);
            else {
              onSelect(entries[to].id);
              buttons.current.get(entries[to].id)?.focus();
            }
          }}
        >
          <span
            className="rule-drag-handle"
            title="Drag to reorder · Alt+↑/↓ with keyboard"
            aria-hidden="true"
            onPointerDown={(event) => {
              drag.start(event, entry.id);
              onSelect(entry.id);
            }}
            onPointerMove={(event) => {
              drag.move(event);
              const bounds = list.current?.getBoundingClientRect();
              if (drag.preview && bounds && list.current) {
                if (event.clientY < bounds.top + 28) list.current.scrollTop -= 16;
                else if (event.clientY > bounds.bottom - 28) list.current.scrollTop += 16;
              }
            }}
            onPointerUp={drag.end}
            onPointerCancel={drag.cancel}
            onLostPointerCapture={drag.cancel}
          >
            <GripVertical size={14} />
          </span>
          <b>{index + 1}</b>
          <span>
            <strong>{entry.name || 'Unnamed entry'}</strong>
            {!compact && <small className="rule-condition-summary">{entry.summary}</small>}
            {entry.destination && <small>→ {entry.destination}</small>}
            {!compact && !entry.enabled && <small>Disabled</small>}
            {!compact && entry.notice && <small className="rule-row-notice">{entry.notice}</small>}
          </span>
          {compact && entry.notice && (
            <AlertCircle size={13} className="rule-notice-icon" aria-label={entry.notice} />
          )}
          <span className="sr-only">{compact && !entry.enabled ? 'Disabled' : ''}</span>
        </button>
      ))}
      {!entries.length && <p className="empty-state">{empty}</p>}
    </div>
  );
}

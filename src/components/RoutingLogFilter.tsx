import { focusMovedOutside } from './focusBoundary';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { ListFilter } from 'lucide-react';

export type LogVisibility<K extends string | null> = { all: boolean; exceptions: Set<K> };
export const allLogItems = <K extends string | null>(): LogVisibility<K> => ({
  all: true,
  exceptions: new Set(),
});
export const logItemVisible = <K extends string | null>(visibility: LogVisibility<K>, id: K) =>
  visibility.all !== visibility.exceptions.has(id);

export default function RoutingLogFilter<K extends string | null>({
  label,
  choices,
  visibility,
  onChange,
}: {
  label: string;
  choices: readonly { id: K; name: string }[];
  visibility: LogVisibility<K>;
  onChange: (next: LogVisibility<K>) => void;
}) {
  const panel = useRef<HTMLDetailsElement>(null);
  const all = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const details = panel.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target))
        details.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const shown = choices.filter((choice) => logItemVisible(visibility, choice.id)).length;
  const mixed = shown > 0 && shown < choices.length;
  useLayoutEffect(() => {
    if (all.current) all.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <details
      ref={panel}
      className="routing-log-choice-filter"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
      onBlur={(event) => {
        if (focusMovedOutside(event.currentTarget, event.relatedTarget))
          event.currentTarget.open = false;
      }}
    >
      <summary>
        <ListFilter size={15} aria-hidden="true" /> {label}
        {shown < choices.length ? ` (${choices.length - shown} hidden)` : ''}
      </summary>
      <fieldset>
        <legend>Visible {label.toLowerCase()}</legend>
        <label className="routing-log-all">
          <input
            ref={all}
            type="checkbox"
            checked={choices.length ? shown === choices.length : visibility.all}
            aria-checked={mixed ? 'mixed' : undefined}
            onChange={(event) => onChange({ all: event.target.checked, exceptions: new Set() })}
          />
          <span>All</span>
        </label>
        {choices.map((choice) => (
          <label key={JSON.stringify(choice.id)}>
            <input
              type="checkbox"
              checked={logItemVisible(visibility, choice.id)}
              onChange={() => {
                const exceptions = new Set(visibility.exceptions);
                if (exceptions.has(choice.id)) exceptions.delete(choice.id);
                else exceptions.add(choice.id);
                onChange({ ...visibility, exceptions });
              }}
            />
            <span title={choice.name}>{choice.name}</span>
          </label>
        ))}
        {!choices.length && <span>No items yet.</span>}
      </fieldset>
    </details>
  );
}

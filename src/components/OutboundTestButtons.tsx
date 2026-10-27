import { useContext } from 'react';
import { Gauge, Timer } from 'lucide-react';
import { OutboundTestsContext, type TestMode } from '../useOutboundTests';
import type { StashEntry } from '../profiles/import';

/** One pair of controls and the same scopes on the graph and all Stash tabs. */
export default function OutboundTestButtons({
  entries,
  nodeIds,
  name,
  all = false,
  iconOnly = true,
  disabled = false,
}: {
  entries?: StashEntry[];
  nodeIds?: string[];
  name?: string;
  all?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
}) {
  const tests = useContext(OutboundTestsContext);
  return (
    <div className="outbound-test-buttons">
      {(['latency', 'speed'] as TestMode[]).map((mode) => {
        const label =
          mode === 'speed'
            ? all
              ? 'Speed test all'
              : `Speed test${name ? ` ${name}` : ''}`
            : all
              ? 'Test all'
              : `Test latency${name ? ` of ${name}` : ''}`;
        const active = tests?.busy && tests.mode === mode;
        const Icon = mode === 'speed' ? Gauge : Timer;
        return (
          <button
            key={mode}
            type="button"
            className={iconOnly ? 'icon-button' : 'secondary-button'}
            aria-label={label}
            title={
              !tests?.desktop
                ? 'Outbound testing requires the desktop app'
                : active
                  ? `${label} — show results`
                  : label
            }
            aria-busy={active || undefined}
            disabled={disabled || !tests?.desktop || (!!tests.busy && !active)}
            onClick={() => (active ? tests.show() : void tests?.start(entries, nodeIds, mode))}
          >
            <Icon size={iconOnly ? 16 : 14} aria-hidden="true" />
            {!iconOnly && label}
          </button>
        );
      })}
    </div>
  );
}

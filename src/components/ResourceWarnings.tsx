import type { ResourceWarningReport } from '../serviceClient';

export default function ResourceWarnings({
  report,
  onResources,
  compact = false,
}: {
  report?: Partial<ResourceWarningReport> | null;
  onResources?: () => void;
  compact?: boolean;
}) {
  const count = report?.skippedSelectorCount ?? 0;
  if (!count) return null;
  return (
    <div
      className={`notice notice--warning${compact ? ' action-row action-row--spread' : ''}`}
      role="status"
    >
      <strong>
        {count} unavailable geodata {count === 1 ? 'entry' : 'entries'} skipped
      </strong>
      {!compact && (
        <>
          <p>Rules with no remaining matches are disabled. Saved entries are preserved.</p>
          <details>
            <summary>Missing groups</summary>
            <ul>
              {report?.skippedSelectors?.map((item, i) => (
                <li key={i}>
                  {item.context}: <code>{item.selector}</code>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {onResources && (
        <button className="secondary-button" onClick={onResources}>
          Resource files
        </button>
      )}
    </div>
  );
}

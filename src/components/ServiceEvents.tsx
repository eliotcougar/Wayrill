import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import type { ServiceEvent, ServiceSnapshot } from '../serviceClient';
import RoutingLogFilter, { allLogItems, logItemVisible } from './RoutingLogFilter';

function eventText(event: ServiceEvent): string {
  const payload = event.payload;
  if (payload && typeof payload === 'object') {
    if (event.kind === 'core.log' && 'message' in payload) return String(payload.message);
    const snapshot = payload as Partial<ServiceSnapshot>;
    if (typeof snapshot.core?.state === 'string' && typeof snapshot.config?.revision === 'number') {
      const failure = snapshot.core.lastError ?? snapshot.config.recoveryError;
      return `Xray: ${snapshot.core.state} · revision ${snapshot.config.revision}${failure ? ` · ${failure.code}: ${failure.message}` : ''}`;
    }
  }
  return JSON.stringify(payload) ?? '';
}

export default function ServiceEvents({
  events,
  active,
  onClear,
}: {
  events: ServiceEvent[];
  active: boolean;
  onClear: () => void;
}) {
  const [search, setSearch] = useState('');
  const [sources, setSources] = useState(allLogItems<string>);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const entries = useMemo(
    () =>
      events.map((event) => ({
        event,
        source: event.kind.split('.')[0],
        text: eventText(event),
      })),
    [events],
  );
  const choices = useMemo(
    () =>
      [...new Set(entries.map((entry) => entry.source))]
        .sort((a, b) => a.localeCompare(b))
        .map((id) => ({ id, name: id })),
    [entries],
  );
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter(
      ({ event, source, text }) =>
        logItemVisible(sources, source) &&
        (!query || `${event.kind} ${text}`.toLowerCase().includes(query)),
    );
  }, [entries, search, sources]);
  const filtered = !!search || !sources.all || sources.exceptions.size > 0;
  useLayoutEffect(() => {
    const element = viewport.current;
    if (active && element && following.current)
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }, [rows, active]);
  useEffect(() => {
    const element = viewport.current;
    if (!active || !element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current)
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  return (
    <section className="runtime-event-log">
      <div className="action-row runtime-event-controls">
        <label className="search-control runtime-event-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search events"
            placeholder="Search events"
            value={search}
            onChange={(event) => {
              following.current = true;
              setSearch(event.target.value);
            }}
          />
        </label>
        <RoutingLogFilter
          label="Sources"
          choices={choices}
          visibility={sources}
          onChange={(next) => {
            following.current = true;
            setSources(next);
          }}
        />
        <button
          className="icon-button"
          aria-label="Reset event filters"
          title="Reset filters"
          disabled={!filtered}
          onClick={() => {
            following.current = true;
            setSearch('');
            setSources(allLogItems());
          }}
        >
          <RotateCcw size={15} />
        </button>
        <button
          className="secondary-button"
          disabled={!events.length}
          onClick={() => {
            following.current = true;
            onClear();
          }}
        >
          Clear view
        </button>
      </div>
      <div
        ref={viewport}
        className="runtime-events"
        role="region"
        aria-label="Service events"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (active)
            following.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <= 4;
        }}
      >
        {rows.length ? (
          rows.map(({ event, text }) => (
            <div key={`${event.instanceId}-${event.sequence}`}>
              <time>{new Date(event.timestampMs).toLocaleTimeString()}</time>
              <strong>{event.kind}</strong>
              <span>{text}</span>
            </div>
          ))
        ) : (
          <p className="empty-state">
            {events.length ? 'No events match the selected filters.' : 'No events received yet.'}
          </p>
        )}
      </div>
    </section>
  );
}

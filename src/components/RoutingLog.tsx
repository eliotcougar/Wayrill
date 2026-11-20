import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Pause, Play, RotateCcw, Search } from 'lucide-react';
import { desktopServiceAvailable, errorText, serviceCall } from '../serviceClient';
import { exportFile } from '../exportFile';
import { maskLogDestination } from '../routingLogPrivacy';
import RoutingLogFilter, { allLogItems, logItemVisible } from './RoutingLogFilter';
import useRoutingLogVisibility from './useRoutingLogVisibility';

type ProcessLabel = { name: string; pid: number };
type ApplicationMatch = { owner: ProcessLabel; ancestors: ProcessLabel[] };

export type RoutingLogRow = {
  id: string;
  timestampMs: number;
  revision: number;
  destination: string;
  output: string;
  outputId: string;
  outbound: string;
  balancer?: string;
  rule: string;
  ruleId: string | null;
  connectionId?: string | null;
  transport?: 'tcp' | 'udp';
  source?: string;
  applicationMatch?: ApplicationMatch;
};
export type RoutingLogSnapshot = {
  instanceId: string;
  generation: number | null;
  revision: number | null;
  state: 'collecting' | 'stopped' | 'unconfigured';
  capacity: number;
  rows: RoutingLogRow[];
  cursor?: string;
  reset?: boolean;
  oldestRetainedId?: string | null;
};
const rowHeight = 32;
const overscan = 6;
const emptyRows: RoutingLogRow[] = [];

// Row IDs are decimal u64 strings, so comparisons stay exact at every service age.
function precedes(a: string, b: string): boolean {
  return a.length === b.length ? a < b : a.length < b.length;
}

function applyPage(
  previous: RoutingLogSnapshot | null,
  page: RoutingLogSnapshot,
): RoutingLogSnapshot {
  if (!previous || page.reset !== false || previous.instanceId !== page.instanceId) return page;
  const { oldestRetainedId, capacity } = page;
  let rows = previous.rows;
  if (oldestRetainedId === null) rows = emptyRows;
  else if (oldestRetainedId && rows.length && precedes(rows[0].id, oldestRetainedId)) {
    const first = rows.findIndex((row) => !precedes(row.id, oldestRetainedId));
    rows = first < 0 ? emptyRows : rows.slice(first);
  }
  if (page.rows.length) {
    const last = rows.at(-1)?.id;
    const incoming = new Map(page.rows.map((row) => [row.id, row]));
    rows = rows.map((row) => incoming.get(row.id) ?? row);
    // Older corrections update a visible row by ID. Rows that have already
    // fallen out of this filter's 1,000-entry window stay out of the display.
    for (const row of page.rows) if (last === undefined || precedes(last, row.id)) rows.push(row);
  }
  if (rows.length > capacity) rows = rows.slice(-capacity);
  if (
    rows === previous.rows &&
    page.generation === previous.generation &&
    page.revision === previous.revision &&
    page.state === previous.state &&
    capacity === previous.capacity
  )
    return previous;
  return { ...page, rows };
}

function outputLabel({ output, balancer, outbound }: RoutingLogRow): string {
  const path = balancer ? [output, balancer, outbound] : [output, outbound];
  return path.filter((label, index) => label !== path[index - 1]).join(' → ');
}

function applicationLabel(match: ApplicationMatch, withPid: boolean): string {
  const process = ({ name, pid }: ProcessLabel) => (withPid ? `${name} (PID ${pid})` : name);
  const owner = process(match.owner);
  return match.ancestors.length ? `${owner} via ${match.ancestors.map(process).join(', ')}` : owner;
}

type RoutingLogProps = {
  filterId: string;
  outputs?: readonly { id: string; name: string }[];
  rules?: readonly { id: string; name: string }[];
  maskAddress?: string;
};

export default function RoutingLog(props: RoutingLogProps) {
  return <FilterRoutingLog key={props.filterId} {...props} />;
}

function FilterRoutingLog({
  filterId,
  outputs = [],
  rules = [],
  maskAddress = '',
}: RoutingLogProps) {
  const [live, setLive] = useState<RoutingLogSnapshot | null>(null);
  const [held, setHeld] = useState<RoutingLogSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const {
    visibility: outputVisibility,
    change: setOutputVisibility,
    error: outputPreferenceError,
  } = useRoutingLogVisibility(filterId, 'outputs');
  const {
    visibility: ruleVisibility,
    change: setRuleVisibility,
    error: rulePreferenceError,
  } = useRoutingLogVisibility(filterId, 'rules');
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const cursor = useRef<string | undefined>(undefined);
  const inFlight = useRef<Promise<RoutingLogSnapshot> | null>(null);
  const scrolled = useRef({ rows: emptyRows, top: 0, instanceId: undefined as string | undefined });
  const [position, setPosition] = useState({ top: 0, height: 320 });
  useEffect(() => {
    if (paused || !desktopServiceAvailable()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      // A pause/resume can happen while a pipe response is still in flight.
      // Wait for it without applying data requested before the pause.
      if (inFlight.current) await inFlight.current.catch(() => {});
      if (disposed) return;
      try {
        const request = serviceCall<RoutingLogSnapshot>('routing.log', {
          filterId,
          ...(cursor.current === undefined ? {} : { since: cursor.current }),
        });
        inFlight.current = request;
        const page = await request;
        if (!disposed) {
          cursor.current = page.cursor;
          setLive((previous) => applyPage(previous, page));
          setError(null);
        }
      } catch (failure) {
        if (!disposed) setError(errorText(failure));
      } finally {
        inFlight.current = null;
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [filterId, paused]);
  const display = paused ? held : live;
  const retained = display?.rows ?? emptyRows;
  const filtered =
    !!search.trim() ||
    !outputVisibility.all ||
    !!outputVisibility.exceptions.size ||
    !ruleVisibility.all ||
    !!ruleVisibility.exceptions.size;
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return filtered
      ? retained.filter(
          (row) =>
            logItemVisible(outputVisibility, row.outputId) &&
            logItemVisible(ruleVisibility, row.ruleId) &&
            (!query || row.destination.toLowerCase().includes(query)),
        )
      : retained;
  }, [retained, filtered, search, outputVisibility, ruleVisibility]);
  const outputChoices = useMemo(() => {
    const choices = new Map(outputs.map((output) => [output.id, output.name]));
    for (const row of retained) choices.set(row.outputId, row.output);
    return [...choices].map(([id, name]) => ({ id, name }));
  }, [outputs, retained]);
  const ruleChoices = useMemo(() => {
    const choices = new Map<string | null, string>([
      [null, 'Unmatched traffic'],
      ...rules.map((rule) => [rule.id, rule.name] as [string, string]),
    ]);
    for (const row of retained) choices.set(row.ruleId, row.rule);
    return [...choices].map(([id, name]) => ({ id, name }));
  }, [rules, retained]);
  const transfer = async (exporting: boolean) => {
    setTransferring(true);
    setTransferError(null);
    const sanitized = rows.map((row) => ({
      ...row,
      destination: maskLogDestination(row.destination, maskAddress),
    }));
    try {
      if (exporting)
        await exportFile(
          'wayrill.routing-log.json',
          JSON.stringify({ revision: display?.revision, rows: sanitized }, null, 2),
        );
      else
        await navigator.clipboard.writeText(
          [
            'Time\tDestination\tOutput\tRule',
            ...sanitized.map((row) =>
              [
                new Date(row.timestampMs).toISOString(),
                row.destination,
                outputLabel(row),
                row.applicationMatch
                  ? `${row.rule} · ${applicationLabel(row.applicationMatch, true)}`
                  : row.rule,
              ].join('\t'),
            ),
          ].join('\n'),
        );
    } catch (failure) {
      setTransferError(errorText(failure));
    } finally {
      setTransferring(false);
    }
  };
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    const instanceId = display?.instanceId;
    const previous = scrolled.current;
    let top = element.scrollTop;
    if (!paused && following.current) {
      top = bottom;
    } else if (previous.rows !== rows && previous.instanceId === instanceId) {
      const anchor = previous.rows[Math.floor(previous.top / rowHeight)];
      const index = anchor ? rows.findIndex((row) => !precedes(row.id, anchor.id)) : -1;
      if (index >= 0) top = index * rowHeight + (previous.top % rowHeight);
    }
    element.scrollTop = Math.min(top, bottom);
    scrolled.current = { rows, top: element.scrollTop, instanceId };
    setPosition({ top: element.scrollTop, height: element.clientHeight || 320 });
  }, [rows, paused, display?.instanceId]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!paused && following.current)
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      scrolled.current.top = element.scrollTop;
      setPosition({ top: element.scrollTop, height: element.clientHeight || 320 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [paused]);
  const first = Math.max(0, Math.floor(position.top / rowHeight) - overscan);
  const end = Math.min(
    rows.length,
    Math.ceil((position.top + position.height - rowHeight) / rowHeight) + overscan,
  );
  const status = !desktopServiceAvailable()
    ? 'Available in the Windows app.'
    : paused
      ? 'Paused'
      : error
        ? error
        : !live
          ? 'Connecting…'
          : live.state === 'unconfigured'
            ? 'Apply this graph to collect its routing log.'
            : live.state === 'stopped'
              ? 'Routing stopped.'
              : 'Collecting';
  return (
    <section className="routing-log" aria-label="Traffic log">
      <div className="action-row action-row--spread routing-log-controls">
        <span role="status">{status}</span>
        <button
          className="icon-button"
          aria-label="Copy displayed log"
          title="Copy displayed log (global destination masking applies)"
          disabled={!rows.length || transferring}
          onClick={() => void transfer(false)}
        >
          <Copy size={15} />
        </button>
        <button
          className="icon-button"
          aria-label="Export displayed log"
          title="Export displayed log (global destination masking applies)"
          disabled={!rows.length || transferring}
          onClick={() => void transfer(true)}
        >
          <Download size={15} />
        </button>
        <button
          className="secondary-button"
          title="Pauses the display only. Resume shows the latest retained decisions; older entries expire from the circular buffer."
          disabled={!live && !paused}
          onClick={() => {
            if (paused) {
              following.current = true;
              setPaused(false);
              setHeld(null);
            } else {
              setHeld(live);
              setPaused(true);
            }
          }}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
          {paused ? 'Resume updates' : 'Pause updates'}
        </button>
      </div>
      <div className="action-row routing-log-filters">
        <label className="search-control routing-log-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search destinations"
            placeholder="Search destinations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <RoutingLogFilter
          label="Outputs"
          choices={outputChoices}
          visibility={outputVisibility}
          onChange={setOutputVisibility}
        />
        <RoutingLogFilter
          label="Rules"
          choices={ruleChoices}
          visibility={ruleVisibility}
          onChange={setRuleVisibility}
        />
        <button
          className="icon-button"
          aria-label="Reset filters"
          title="Reset filters"
          disabled={!filtered}
          onClick={() => {
            setSearch('');
            setOutputVisibility(allLogItems());
            setRuleVisibility(allLogItems());
          }}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      {(transferError || outputPreferenceError || rulePreferenceError) && (
        <p className="notice notice--error" role="alert">
          {transferError || outputPreferenceError || rulePreferenceError}
        </p>
      )}
      <div
        className="routing-log-table"
        role="table"
        aria-label="Routing decisions"
        aria-rowcount={rows.length + 1}
        aria-colcount={4}
      >
        <div
          ref={viewport}
          className="routing-log-viewport"
          tabIndex={0}
          role="rowgroup"
          aria-label="Routing log rows"
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <= 4;
            scrolled.current.top = element.scrollTop;
            setPosition({ top: element.scrollTop, height: element.clientHeight || 320 });
          }}
        >
          <div className="routing-log-content">
            <div className="routing-log-row routing-log-header" role="row" aria-rowindex={1}>
              {['Time', 'Domain / IP:port', 'Output', 'Rule'].map((name) => (
                <span role="columnheader" key={name}>
                  {name}
                </span>
              ))}
            </div>
            <div className="routing-log-spacer" style={{ height: rows.length * rowHeight }}>
              {rows.slice(first, end).map((row, offset) => {
                const output = outputLabel(row);
                const time = new Date(row.timestampMs);
                return (
                  <div
                    className="routing-log-row routing-log-entry"
                    role="row"
                    aria-rowindex={first + offset + 2}
                    key={`${display?.instanceId}/${row.id}`}
                    style={{ top: (first + offset) * rowHeight }}
                  >
                    <span role="cell" title={time.toLocaleString()}>
                      {time.toLocaleTimeString()}
                    </span>
                    <span
                      role="cell"
                      title={[
                        row.destination,
                        row.transport?.toUpperCase(),
                        row.source,
                        row.connectionId ? `Connection ${row.connectionId}` : '',
                        `Revision ${row.revision}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      data-log-destination={row.destination}
                    >
                      {row.destination}
                    </span>
                    <span role="cell" title={output}>
                      {output}
                    </span>
                    <span
                      role="cell"
                      className="routing-log-rule"
                      title={[
                        row.rule,
                        row.applicationMatch
                          ? `Application match for this route · ${applicationLabel(row.applicationMatch, true)}`
                          : '',
                        `Revision ${row.revision}`,
                      ]
                        .filter(Boolean)
                        .join('\n')}
                    >
                      <span>{row.rule}</span>
                      {row.applicationMatch && (
                        <span className="routing-log-rule-application">
                          {applicationLabel(row.applicationMatch, false)}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {!rows.length && (
              <p className="empty-state">
                {retained.length && filtered
                  ? 'No matching destinations.'
                  : 'No routing decisions yet.'}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="action-row action-row--spread routing-log-footer">
        <span>
          {paused
            ? 'Display paused · collection continues'
            : filtered
              ? `${rows.length} shown · ${retained.length} retained`
              : `${rows.length} / ${live?.capacity ?? 1000} latest decisions`}
        </span>
        {display?.revision != null && <span>Revision {display.revision}</span>}
      </div>
    </section>
  );
}

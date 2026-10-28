import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Pause, Play, RotateCcw, Search } from 'lucide-react';
import { desktopServiceAvailable, errorText, serviceCall } from '../serviceClient';
import { exportFile } from '../exportFile';
import { maskLogDestination } from '../routingLogPrivacy';
import RoutingLogFilter, { allLogItems, logItemVisible } from './RoutingLogFilter';
import useRoutingLogVisibility from './useRoutingLogVisibility';

export type RoutingLogRow = {
  id: string;
  timestampMs: number;
  revision: number;
  destination: string;
  output: string;
  outputId: string;
  outbound: string;
  rule: string;
  ruleId: string | null;
  connectionId?: string | null;
  transport?: 'tcp' | 'udp';
  source?: string;
};
export type RoutingLogSnapshot = {
  instanceId: string;
  generation: number | null;
  revision: number | null;
  state: 'collecting' | 'stopped' | 'unconfigured';
  capacity: number;
  rows: RoutingLogRow[];
};
const rowHeight = 32;
const overscan = 6;
const emptyRows: RoutingLogRow[] = [];

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
  const [position, setPosition] = useState({ top: 0, height: 320 });
  useEffect(() => {
    if (!desktopServiceAvailable()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await serviceCall<RoutingLogSnapshot>('routing.log', { filterId });
        if (!disposed) {
          setLive(snapshot);
          setError(null);
        }
      } catch (failure) {
        if (!disposed) setError(errorText(failure));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [filterId]);
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
                row.output === row.outbound ? row.output : `${row.output} → ${row.outbound}`,
                row.rule,
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
  // Following is deliberately disabled only while paused. New rows cannot
  // move a held selection, even as polling fills the service's circular buffer.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = paused ? Math.min(element.scrollTop, bottom) : bottom;
    setPosition({ top: element.scrollTop, height: element.clientHeight || 320 });
  }, [rows, paused]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!paused) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
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
      <div className="routing-log-controls">
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
      <div className="routing-log-filters">
        <label className="palette-search routing-log-search">
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
        <p className="runtime-error" role="alert">
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
                const output =
                  row.output === row.outbound ? row.output : `${row.output} → ${row.outbound}`;
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
                    <span role="cell" title={`${row.rule} · Revision ${row.revision}`}>
                      {row.rule}
                    </span>
                  </div>
                );
              })}
            </div>
            {!rows.length && (
              <p className="routing-log-empty">
                {retained.length && filtered
                  ? 'No matching destinations.'
                  : 'No routing decisions yet.'}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="routing-log-footer">
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

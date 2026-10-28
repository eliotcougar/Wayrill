import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import TrafficUnitSettings from './TrafficUnitSettings';
import { useTrafficUnits } from '../trafficUnits';
import useModalDialog from './useModalDialog';
import {
  RotateCcw,
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Pause,
  Play,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeController } from '../useRuntime';
import useTrafficHistory from '../useTrafficHistory';
import useTrafficEndpoints from '../useTrafficEndpoints';
import { LIMITS } from '../limits';
import {
  formatBytes,
  formatRate,
  type TrafficSnapshot,
  type TrafficPoint,
  type TrafficSortColumn,
} from '../traffic';
import { sampleTime, trafficStatus } from '../trafficPresentation';
import TrafficChart from './TrafficChart';
import {
  loadTrafficSortPreferences,
  saveTrafficSortPreferences,
  sortTrafficEndpoints,
} from '../trafficSorting';
import { endpointDisplayName, type DisplayNames } from '../graph/displayNames';

type EndpointView = Pick<
  ReturnType<typeof useTrafficEndpoints>,
  'rows' | 'total' | 'offset' | 'paged' | 'fresh' | 'error'
>;
type PausedView = {
  timestamp: number;
  context: string;
  traffic: TrafficSnapshot | undefined;
  points: TrafficPoint[];
  endpoints: EndpointView;
  ratesAvailable: boolean;
  displayNames?: DisplayNames;
};
const contextKey = (runtime: RuntimeController) =>
  `${runtime.snapshot?.instanceId}:${runtime.snapshot?.traffic?.generation}:${runtime.snapshot?.traffic?.revision}:${runtime.snapshot?.traffic?.counterEpoch ?? 0}`;
const byteTitle = (value: string | undefined) =>
  value == null ? 'No measurement' : `${value} bytes`;

export default function TrafficPanel({
  runtime,
  history,
  onClose,
}: {
  runtime: RuntimeController;
  history: ReturnType<typeof useTrafficHistory>;
  onClose: () => void;
}) {
  const units = useTrafficUnits();
  const bytes = (value: string | undefined) => formatBytes(value, units.amount);
  const rate = (value: number | null | undefined) => formatRate(value, units.rate);
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'overview' | 'inbound' | 'outbound'>('overview');
  const [minutes, setMinutes] = useState(5),
    [now, setNow] = useState(Date.now());
  const [paused, setPaused] = useState<PausedView | null>(null);
  const [preferences, setPreferences] = useState(() => loadTrafficSortPreferences());
  const sorts = preferences.sorts;
  const sort = sorts[tab === 'inbound' ? 'inbound' : 'outbound'];
  const [resetError, setResetError] = useState('');
  useModalDialog(dialog);
  const tabs = useEditorTabs(
    [
      { key: 'overview', label: 'Overview' },
      { key: 'inbound', label: 'Traffic sources' },
      { key: 'outbound', label: 'Outbounds' },
    ],
    tab,
    setTab,
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);
  const currentTraffic = runtime.snapshot?.traffic,
    supported = runtime.capabilities.includes('xray.statistics');
  const currentEndpoints = useTrafficEndpoints(runtime, tab, !!paused, sort);
  const monitor = trafficStatus(currentTraffic, now);
  const live = runtime.desktop && runtime.connected && supported && monitor.live;
  const status = !runtime.desktop
    ? 'Desktop app required'
    : !runtime.connected
      ? 'Service offline'
      : !supported
        ? 'Update the networking service'
        : monitor.label;
  const coreStatus =
    !runtime.desktop || !runtime.connected
      ? 'Core state unknown'
      : `Core ${runtime.snapshot?.core?.state ?? 'state unknown'}`;
  const traffic = paused ? paused.traffic : currentTraffic;
  const points = paused ? paused.points : history.points;
  const endpoints = paused ? paused.endpoints : currentEndpoints;
  const ratesAvailable = paused ? paused.ratesAvailable : live;
  const liveNames =
    currentTraffic?.revision === runtime.savedRevision ? runtime.savedDisplayNames : undefined;
  const names = paused ? paused.displayNames : liveNames;
  const rows = useMemo(
    () =>
      endpoints.paged
        ? endpoints.rows
        : sortTrafficEndpoints(endpoints.rows, sort, names, ratesAvailable),
    [endpoints.paged, endpoints.rows, sort, names, ratesAvailable],
  );
  const sortBlocked = paused
    ? 'Resume display to sort'
    : endpoints.paged && !runtime.connected
      ? 'Connect to the service to sort'
      : endpoints.paged && !runtime.capabilities.includes('xray.statistics.sorting')
        ? 'Update the networking service to sort'
        : '';
  const sortColumn = (column: TrafficSortColumn) => {
    const scope = tab === 'inbound' ? 'inbound' : 'outbound';
    const next = {
      ...sorts,
      [scope]: {
        column,
        direction:
          sorts[scope].column === column
            ? sorts[scope].direction === 'asc'
              ? 'desc'
              : 'asc'
            : column === 'name'
              ? 'asc'
              : 'desc',
      },
    };
    setPreferences({ sorts: next, error: saveTrafficSortPreferences(next) });
  };
  const contextChanged = paused && paused.context !== contextKey(runtime);
  const togglePause = () => {
    if (paused) {
      setPaused(null);
      return;
    }
    setPaused({
      timestamp: Date.now(),
      displayNames: liveNames ? structuredClone(liveNames) : undefined,
      context: contextKey(runtime),
      traffic: currentTraffic ? structuredClone(currentTraffic) : undefined,
      points: history.points.map((p) => ({ ...p })),
      ratesAvailable: live,
      endpoints: {
        rows: currentEndpoints.rows.map((row) => ({ ...row })),
        total: currentEndpoints.total,
        offset: currentEndpoints.offset,
        paged: currentEndpoints.paged,
        fresh: currentEndpoints.fresh,
        error: currentEndpoints.error,
      },
    });
  };
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window traffic-window dialog--compact"
      aria-labelledby="traffic-title"
      onClose={onClose}
      onCancel={onClose}
      onPointerDown={(event) => {
        const units = event.currentTarget.querySelector<HTMLDetailsElement>(
          '.traffic-units-disclosure',
        );
        if (units?.open && !units.contains(event.target as Node)) units.open = false;
      }}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="traffic-title" title="Observed payload traffic through Xray">
            <Activity size={19} /> Traffic statistics
          </h2>
        </div>
        <button className="icon-button" aria-label="Close traffic statistics" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {resetError && (
        <p className="notice notice--error" role="alert">
          {resetError}
        </p>
      )}
      {preferences.error && (
        <p className="notice notice--error" role="alert">
          {preferences.error}
        </p>
      )}
      <div className="action-row traffic-display-controls">
        <button
          className="secondary-button"
          disabled={
            !runtime.connected ||
            runtime.busy ||
            !runtime.capabilities.includes('xray.statistics.reset')
          }
          title="Reset session, accumulated and endpoint counters, and clear chart history."
          onClick={() => {
            setResetError('');
            void runtime
              .run('traffic.reset')
              .then(() => {
                setPaused(null);
                history.refresh();
              })
              .catch((e) => setResetError(e instanceof Error ? e.message : String(e)));
          }}
        >
          <RotateCcw size={14} />
          Reset counters
        </button>
        <button
          className="secondary-button"
          aria-pressed={!!paused}
          title="Pause the display; traffic and collection continue."
          disabled={!paused && !traffic && !points.length}
          onClick={togglePause}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? 'Resume display' : 'Pause display'}
        </button>
        <span role="status">
          {paused ? (
            <>
              Display paused at{' '}
              <time
                dateTime={new Date(paused.timestamp).toISOString()}
                title={new Date(paused.timestamp).toLocaleString()}
              >
                {sampleTime(paused.timestamp)}
              </time>
            </>
          ) : (
            'Live display'
          )}
        </span>
        <span className="traffic-runtime-state" role="status">
          {coreStatus} · <span className={live ? 'online' : ''}>{status}</span>
        </span>
        <details
          className="traffic-units-disclosure"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !event.currentTarget.open) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }}
        >
          <summary>Units</summary>
          <TrafficUnitSettings />
        </details>
      </div>
      <EditorTabs tabs={tabs} label="Traffic views" disabled={!!paused} />
      <EditorTabPanels
        tabs={tabs}
        className={(key) =>
          `runtime-body traffic-body ${key === 'overview' ? 'traffic-overview-body' : 'traffic-endpoints-body'}`
        }
      >
        {contextChanged && (
          <p className="notice">
            The service/core session changed; resume to see its current counters.
          </p>
        )}
        {!runtime.desktop && (
          <p className="notice">
            Open the Windows app to collect live traffic. The browser preview does not run Xray.
          </p>
        )}
        {currentTraffic?.error && (
          <p className="notice">
            {currentTraffic.error} Monitoring failure does not establish whether routing stopped.
          </p>
        )}
        {currentTraffic?.persistenceError && (
          <p className="notice notice--error" role="alert">
            {currentTraffic.persistenceError}
          </p>
        )}
        {history.error && (
          <p className="notice">
            Chart history could not be loaded. Current samples still appear.{' '}
            <button className="secondary-button" onClick={history.refresh}>
              Retry history
            </button>
          </p>
        )}
        {tab === 'overview' ? (
          <>
            <div className="traffic-cards">
              {(['upload', 'download'] as const).map((direction) => (
                <section
                  key={direction}
                  className={`editor-panel editor-panel--outlined traffic-card ${direction}`}
                  aria-label={`${direction} traffic`}
                >
                  <span className="traffic-card-heading">
                    {direction === 'upload' ? <ArrowUp size={17} /> : <ArrowDown size={17} />}
                    {direction === 'upload' ? 'Upload' : 'Download'}
                  </span>
                  <strong
                    className="traffic-rate"
                    title={`${rate(0)} means measured idle traffic; — means no rate measurement.`}
                  >
                    {rate(ratesAvailable ? traffic?.[`${direction}PerSecond`] : null)}
                  </strong>
                  <dl>
                    <div>
                      <dt>Core session total</dt>
                      <dd title={byteTitle(traffic?.[`${direction}Bytes`])}>
                        {bytes(traffic?.[`${direction}Bytes`])}
                      </dd>
                    </div>
                    <div>
                      <dt>Accumulated observed</dt>
                      <dd
                        title={byteTitle(
                          traffic?.[
                            direction === 'upload'
                              ? 'accumulatedUploadBytes'
                              : 'accumulatedDownloadBytes'
                          ],
                        )}
                      >
                        {bytes(
                          traffic?.[
                            direction === 'upload'
                              ? 'accumulatedUploadBytes'
                              : 'accumulatedDownloadBytes'
                          ],
                        )}
                      </dd>
                    </div>
                  </dl>
                </section>
              ))}
            </div>
            <div className="action-row action-row--spread compact-controls traffic-chart-toolbar">
              <h3>Rate history{paused ? ' · paused' : ''}</h3>
              <label className="inline-field">
                Show{' '}
                <select
                  className="text-control"
                  aria-label="Traffic chart time window"
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                >
                  <option value={1}>1 minute</option>
                  <option value={5}>5 minutes</option>
                  <option value={10}>10 minutes</option>
                </select>
              </label>
            </div>
            <TrafficChart points={points} minutes={minutes} unit={units.rate} />
          </>
        ) : (
          <>
            <p className="runtime-scope">
              {tab === 'inbound'
                ? 'Traffic received from and returned to each input in this core session.'
                : 'Traffic sent and received at each outbound in this core session. Chained outbounds can count the same payload at multiple stages; these rows are not added to the overall total.'}{' '}
              {rate(0)} means measured idle traffic; — means no rate measurement.
            </p>
            <div className="traffic-table-scroll">
              <table className="data-table data-table--sticky traffic-table">
                <thead>
                  <tr>
                    {(
                      [
                        ['name', tab === 'inbound' ? 'Source' : 'Outbound'],
                        ['uploadPerSecond', 'Upload rate'],
                        ['downloadPerSecond', 'Download rate'],
                        ['uploadBytes', 'Uploaded'],
                        ['downloadBytes', 'Downloaded'],
                      ] as const
                    ).map(([column, label]) => (
                      <th
                        key={column}
                        scope="col"
                        aria-sort={
                          sort.column === column
                            ? sort.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <button
                          className="traffic-sort-header"
                          type="button"
                          disabled={!!sortBlocked}
                          title={sortBlocked || `Sort by ${label.toLowerCase()}`}
                          onClick={() => sortColumn(column)}
                        >
                          {label}
                          {sort.column !== column ? (
                            <ChevronsUpDown size={13} aria-hidden="true" />
                          ) : sort.direction === 'asc' ? (
                            <ArrowUp size={13} aria-hidden="true" />
                          ) : (
                            <ArrowDown size={13} aria-hidden="true" />
                          )}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.tag}>
                      <th scope="row" title={row.tag}>
                        <bdi>
                          {endpointDisplayName(
                            names,
                            tab === 'inbound' ? 'inbound' : 'outbound',
                            row.tag,
                          )}
                        </bdi>
                      </th>
                      <td>
                        {rate(ratesAvailable && endpoints.fresh ? row.uploadPerSecond : null)}
                      </td>
                      <td>
                        {rate(ratesAvailable && endpoints.fresh ? row.downloadPerSecond : null)}
                      </td>
                      <td title={byteTitle(row.uploadBytes)}>{bytes(row.uploadBytes)}</td>
                      <td title={byteTitle(row.downloadBytes)}>{bytes(row.downloadBytes)}</td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={5}>
                        {endpoints.paged && endpoints.total
                          ? paused
                            ? 'No endpoint page was available when paused.'
                            : 'Loading endpoint counters…'
                          : runtime.connected && runtime.snapshot?.core?.state === 'stopped'
                            ? 'No endpoint counters. Start the applied graph to collect statistics.'
                            : 'No endpoint counters available for this session.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {endpoints.error && (
              <p className="notice notice--error" role="alert">
                {endpoints.error}{' '}
                <button
                  className="secondary-button"
                  disabled={!!paused}
                  onClick={currentEndpoints.refresh}
                >
                  Retry
                </button>
              </p>
            )}
            {endpoints.paged && (
              <div className="policy-pagination">
                <button
                  className="secondary-button"
                  disabled={!!paused || !endpoints.offset}
                  onClick={() =>
                    currentEndpoints.setOffset(endpoints.offset - LIMITS.endpointPageSize)
                  }
                >
                  Previous
                </button>
                <span>
                  {endpoints.total
                    ? `${endpoints.offset + 1}–${Math.min(endpoints.offset + LIMITS.endpointPageSize, endpoints.total)} of ${endpoints.total.toLocaleString()}`
                    : 'No endpoint counters'}
                  {!endpoints.fresh && endpoints.total > 0
                    ? paused
                      ? ' · page was incomplete when paused'
                      : ' · updating'
                    : ''}
                </span>
                <button
                  className="secondary-button"
                  disabled={
                    !!paused || endpoints.offset + LIMITS.endpointPageSize >= endpoints.total
                  }
                  onClick={() =>
                    currentEndpoints.setOffset(endpoints.offset + LIMITS.endpointPageSize)
                  }
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </EditorTabPanels>
      <div className="rule-editor-footer">
        <span>
          {traffic?.generation
            ? `${paused ? 'Displayed' : 'Counters from'} core session ${traffic.generation} · session revision ${traffic.revision}`
            : 'No core session counters'}
          {traffic?.lastSample && (
            <>
              {' '}
              ·{' '}
              <time
                dateTime={new Date(traffic.lastSample.timestampMs).toISOString()}
                title={`Last displayed sample: ${new Date(traffic.lastSample.timestampMs).toLocaleString()}`}
              >
                {sampleTime(traffic.lastSample.timestampMs)}
              </time>
            </>
          )}
        </span>
        <button className="secondary-button" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

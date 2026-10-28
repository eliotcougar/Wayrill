import { useMemo, useRef, useState } from 'react';
import { Gauge, Timer, X } from 'lucide-react';
import useModalDialog from './useModalDialog';
import ResultPager from './ResultPager';
import { summarizeTest, type OutboundTests } from '../useOutboundTests';
import UdpTestBadge from './UdpTestBadge';
import { mergeTestPlans, type TestRow, type TestSelection } from '../outboundTestPlan';
export default function OutboundTestResults({ tests }: { tests: OutboundTests }) {
  const ref = useRef<HTMLDialogElement>(null);
  useModalDialog(ref);
  const [page, setPage] = useState(0),
    [view, setView] = useState<'items' | 'unique'>('items');
  const { latency, speed } = tests.records;
  const plan = useMemo(
    () => ({
      rows: mergeTestPlans(latency.plan, speed.plan ?? { rows: [], targets: [] }).rows,
      targets: [
        ...new Map(
          [...(latency.plan?.targets ?? []), ...(speed.plan?.targets ?? [])].map((target) => [
            target.id,
            target,
          ]),
        ).values(),
      ],
    }),
    [latency.plan, speed.plan],
  );
  const rows: TestRow[] =
    view === 'items'
      ? plan.rows.filter((r) => !r.hidden)
      : plan.targets.map((t) => ({ key: t.id, name: t.name, kind: 'outbound', targets: [t.id] }));
  const latencyRows = useMemo(
    () => new Map(latency.plan?.rows.map((row) => [row.key, row])),
    [latency.plan],
  );
  const speedRows = useMemo(
    () => new Map(speed.plan?.rows.map((row) => [row.key, row])),
    [speed.plan],
  );
  const targets = useMemo(
    () => new Map(plan.targets.map((target) => [target.id, target])),
    [plan.targets],
  );
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 50) - 1));
  return (
    <dialog
      ref={ref}
      className="app-dialog outbound-tests-window"
      aria-labelledby="outbound-tests-title"
      onClose={() => tests.setOpen(false)}
    >
      <div className="dialog-header">
        <h2 id="outbound-tests-title">Outbound tests</h2>
        <button
          className="icon-button"
          aria-label="Close outbound test results"
          onClick={() => tests.setOpen(false)}
        >
          <X size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <div className="action-row action-row--spread compact-controls outbound-test-controls">
          <span role="status">{tests.status}</span>
          <label className="inline-field">
            Results{' '}
            <select
              className="text-control"
              value={view}
              onChange={(e) => {
                setView(e.target.value as typeof view);
                setPage(0);
              }}
            >
              <option value="items">Summary</option>
              <option value="unique">Individual outbounds / chains</option>
            </select>
          </label>
        </div>
        {tests.error && (
          <p className="notice notice--error" role="alert">
            {tests.error}
          </p>
        )}
        <div className="outbound-test-table" role="table" aria-label="Outbound test results">
          <div role="row" className="outbound-test-row">
            <strong role="columnheader">Outbound</strong>
            <strong role="columnheader">Delay / UDP</strong>
            <strong role="columnheader">Download speed</strong>
            <strong role="columnheader">Exit IP / details</strong>
            <span role="columnheader" aria-label="Test actions" />
          </div>
          {rows.slice(current * 50, (current + 1) * 50).map((row) => {
            const emptyGroup = row.kind === 'policy-group' ? { ...row, targets: [] } : row;
            const delay = summarizeTest(latencyRows.get(row.key) ?? emptyGroup, latency.results);
            // Latency expands a policy into its candidates; a speed test measures
            // its current winner. Those two target sets are not interchangeable.
            const speedRow = speedRows.get(row.key) ?? emptyGroup;
            const download = summarizeTest(speedRow, speed.results, 'speed');
            const target = view === 'unique' ? targets.get(row.key) : undefined;
            const selection: TestSelection | undefined =
              view === 'items'
                ? { key: row.key }
                : target?.origin
                  ? { id: target.id, origin: target.origin }
                  : undefined;
            const details = [delay.title, download.title].filter(Boolean).join('\n');
            return (
              <div role="row" className="outbound-test-row" key={row.key}>
                <span role="cell" dir="auto" title={row.name}>
                  {row.name}
                </span>
                <span role="cell" className={delay.state}>
                  {delay.text}
                  <UdpTestBadge result={delay.udp} />
                </span>
                <span role="cell" className={download.state} title={download.title}>
                  {download.text}
                </span>
                <span role="cell" title={details}>
                  {details || '—'}
                </span>
                <span role="cell" className="outbound-test-buttons">
                  <button
                    className="icon-button"
                    title="Test delay / UDP"
                    aria-label={`Test delay / UDP for ${row.name}`}
                    disabled={tests.busy || !tests.desktop || !!row.error || !selection}
                    onClick={() => selection && void tests.retest(selection, 'latency')}
                  >
                    <Timer size={16} />
                  </button>
                  <button
                    className="icon-button"
                    title="Speed test"
                    aria-label={`Speed test ${row.name}`}
                    disabled={tests.busy || !tests.desktop || !!row.error || !selection}
                    onClick={() => selection && void tests.retest(selection, 'speed')}
                  >
                    <Gauge size={16} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        <ResultPager
          count={rows.length}
          size={50}
          page={current}
          label="Outbound tests"
          onPage={setPage}
        />
      </div>
      <div className="dialog-footer">
        {tests.busy && (
          <button className="secondary-button" onClick={tests.cancel}>
            Cancel tests
          </button>
        )}
        <button className="primary-button" onClick={() => tests.setOpen(false)}>
          Close
        </button>
      </div>
    </dialog>
  );
}

import { useRef, useState } from 'react';
import Dialog from '../components/Dialog';
import './pool.css';
import { parseGraph } from '../graph/model';
import type { GraphState } from '../graph/types';
import {
  refreshServiceStash,
  readSubscriptionDocument,
  readSubscriptionProgress,
  waitSubscriptionJob,
} from '../profiles/serviceSubscriptions';
import { errorText, serviceCall } from '../serviceClient';
import { choosePoolFolder } from './handoff';
import type { PoolCapture, PoolEntries } from './model';
import { portLabel } from '../graph/catalog';
import type { PoolOptions, PoolSelection } from './delivery';
import PoolOutboundChoice from './PoolOutboundChoice';
import { PoolSettingSummary } from './PoolSettingFields';
import type usePoolStatus from './usePoolStatus';

type Preview = PoolEntries & {
  digest: string;
  revision: number;
  selection?: PoolSelection;
  options?: PoolOptions;
};

export default function PoolConnection({
  poolStatus,
  revision,
  testsBusy,
  onOpenGraph,
  onTestGraph,
  hasDifferentDraft,
  onClose,
}: {
  poolStatus: ReturnType<typeof usePoolStatus>;
  revision: number | undefined;
  testsBusy: boolean;
  onOpenGraph: (graph: GraphState) => void;
  onTestGraph: (graph: GraphState) => void;
  hasDifferentDraft: (graph: GraphState) => boolean;
  onClose: () => void;
}) {
  const { status, accept, error: statusError } = poolStatus;
  const [kind, setKind] = useState<'folder' | 'url'>('folder');
  const [address, setAddress] = useState('');
  const [invite, setInvite] = useState('');
  const [capture, setCapture] = useState<PoolCapture>('current');
  const [start, setStart] = useState(true);
  const [preview, setPreview] = useState<Preview>();
  const [customize, setCustomize] = useState(false);
  const [selection, setSelection] = useState<PoolSelection>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [justConnected, setJustConnected] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const [keepStash, setKeepStash] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checkResult, setCheckResult] = useState<{ at?: number | null; message: string }>();
  const pending = useRef(false);
  const [intervalDraft, setIntervalDraft] = useState<string>();
  const interval = intervalDraft ?? String(status?.connection?.refreshMinutes ?? 5);
  const refreshMinutes = Number(interval);
  const intervalValid =
    Number.isInteger(refreshMinutes) && refreshMinutes >= 1 && refreshMinutes <= 1440;
  const intervalField = (
    <label className="editor-field">
      <span>Check for updates every (minutes)</span>
      <input
        type="number"
        min={1}
        max={1440}
        step={1}
        value={interval}
        onChange={(event) => setIntervalDraft(event.currentTarget.value)}
      />
    </label>
  );
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailure('');
    try {
      await action();
    } catch (reason) {
      setFailure(errorText(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function openGraph(test = false, confirmed = false) {
    const result = await readSubscriptionDocument('applied');
    const graph = result.text && parseGraph(result.text);
    if (!graph || !graph.poolId) throw new Error('There is no applied Pool graph to open.');
    if (!test && !confirmed && hasDifferentDraft(graph)) {
      setConfirmOpen(true);
      return;
    }
    await refreshServiceStash();
    (test ? onTestGraph : onOpenGraph)(graph);
  }
  const source = () => ({ kind, address: address.trim(), invite: invite.trim() });
  function pasteInvitation(text: string) {
    const [heading, source, key] = text.trim().split(/\r?\n/);
    if (
      heading !== 'Wayrill Pool invitation' ||
      !source ||
      !key ||
      !/^wp1\.[0-9a-f]{32}\.[0-9a-f]{64}$/.test(key)
    )
      return false;
    setKind(/^https?:\/\//i.test(source) ? 'url' : 'folder');
    setAddress(source);
    setInvite(key);
    return true;
  }
  async function inspect(connected: boolean, choice?: PoolSelection, keepBindings = true) {
    const { job } = await serviceCall<{ job: number }>('pool.preview', {
      ...(connected ? {} : { source: source() }),
      capture: connected ? 'current' : capture,
      expectedRevision: revision,
      ...(choice && preview
        ? {
            selection: choice,
            expectedDigest: preview.digest,
            ...(keepBindings ? { bindings: assignments } : { resetBindings: true }),
          }
        : {}),
    });
    await waitSubscriptionJob(job);
    const next = await serviceCall<Preview>('pool.previewResult', { job });
    setPreview(next);
    setSelection(next.selection);
    if (!choice) setCustomize(connected);
  }

  async function command(method: string, params?: Record<string, unknown>) {
    const { job } = await serviceCall<{ job: number }>(method, params);
    await waitSubscriptionJob(job);
    const next = await readSubscriptionProgress<NonNullable<typeof status>>('pool.status');
    accept(next);
    return next;
  }

  async function checkNow() {
    setCheckResult(undefined);
    const next = await command('pool.refresh');
    setCheckResult({
      at: next.lastCheckAt,
      message:
        next.connection?.appliedAt !== status?.connection?.appliedAt
          ? 'Pool update applied.'
          : 'Your applied Pool delivery is up to date.',
    });
  }

  const known = new Set(preview?.placeholders.map(({ id }) => id));
  const assignments = Object.fromEntries(
    (preview?.inbounds ?? []).flatMap(({ id }) => {
      const target =
        preview && Object.hasOwn(preview.bindings, id) ? preview.bindings[id] : undefined;
      return target && known.has(target) ? [[id, target]] : [];
    }),
  );
  const complete = preview?.inbounds.every(
    ({ id, enabled }) => !enabled || Object.hasOwn(assignments, id),
  );
  const singleRoute = preview?.inbounds.length === 1 && preview.placeholders.length === 1;
  const options = preview?.options;
  const connected = !!status?.connection;
  const defaultChoice =
    selection?.graph === options?.defaultGraph &&
    !selection?.stashes &&
    !selection?.filters &&
    !selection?.outbounds;

  return (
    <Dialog
      title={
        confirmOpen
          ? 'Replace the open draft?'
          : disconnect
            ? 'Disconnect from Pool'
            : preview
              ? 'Choose Pool configuration'
              : status?.connection
                ? 'Pool connection'
                : 'Connect to Pool'
      }
      onClose={onClose}
      busy={busy}
      className="pool-dialog"
    >
      {confirmOpen ? (
        <fieldset disabled={busy}>
          <legend>Open applied graph</legend>
          <p>This replaces the graph in the editor. Undo restores your current draft.</p>
          <div className="pool-dialog-actions">
            <button className="secondary-button" onClick={() => setConfirmOpen(false)}>
              Keep draft
            </button>
            <button
              className="primary-button"
              onClick={() => void run(() => openGraph(false, true))}
            >
              Replace draft
            </button>
          </div>
        </fieldset>
      ) : disconnect ? (
        <fieldset disabled={busy || status?.busy}>
          <legend>{status?.connection?.poolName ?? status?.connection?.name}</legend>
          <p>
            Disconnecting ends Pool updates. The applied graph can still use its saved server
            settings.
          </p>
          <label className="check-control">
            <input
              type="checkbox"
              checked={keepStash}
              onChange={(event) => setKeepStash(event.currentTarget.checked)}
            />
            Keep this Pool’s entries in the Stash
          </label>
          <div className="pool-dialog-actions">
            <button className="secondary-button" onClick={() => setDisconnect(false)}>
              Cancel
            </button>
            <button
              className="primary-button"
              onClick={() =>
                void run(async () => {
                  await command('pool.disconnect', { keepStash });
                  setDisconnect(false);
                  setJustConnected(false);
                  setAddress('');
                  setInvite('');
                  setIntervalDraft(undefined);
                })
              }
            >
              Disconnect
            </button>
          </div>
        </fieldset>
      ) : preview ? (
        <fieldset disabled={busy || status?.busy}>
          <legend>{preview.name}</legend>
          {preview.settings && (
            <details className="editor-advanced" open>
              <summary>App settings provided by this Pool</summary>
              <PoolSettingSummary settings={preview.settings} />
            </details>
          )}
          {options && selection && (
            <>
              {options.reviewRequired && (
                <div className="notice notice--warning">
                  <p>
                    A previous selection is unavailable. Choose a replacement or use the graph
                    defaults.
                  </p>
                  {!!options.unavailable?.length && (
                    <ul>
                      {options.unavailable.map((message, index) => (
                        <li key={index}>{message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <p>Use the defaults for this graph, or choose which layers and outbounds to use.</p>
              <button className="secondary-button" onClick={() => setCustomize(!customize)}>
                {customize ? 'Hide configuration choices' : 'Customize configuration…'}
              </button>
              {customize && (
                <>
                  <label className="editor-field">
                    <span>Graph for this computer</span>
                    <select
                      value={selection.graph}
                      onChange={(event) => {
                        const graph = event.currentTarget.value;
                        void run(() => inspect(connected, { graph }, false));
                      }}
                    >
                      {options.graphs.map(({ id, name }) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!!options.stashes.length && (
                    <fieldset>
                      <legend>Stash layers</legend>
                      {options.stashes.map(({ id, name }) => (
                        <label key={id} className="check-control">
                          <input
                            type="checkbox"
                            checked={options.activeStashes.includes(id)}
                            onChange={(event) => {
                              const stashes = event.currentTarget.checked
                                ? [...options.activeStashes, id]
                                : options.activeStashes.filter((item) => item !== id);
                              void run(() =>
                                inspect(connected, { ...selection, stashes, followDefault: false }),
                              );
                            }}
                          />
                          {name}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {options.filters
                    .filter(({ choices }) => choices.length)
                    .map(({ id, name, choices, active }) => (
                      <label className="editor-field" key={id}>
                        <span>{name}</span>
                        <select
                          value={selection.filters ? (selection.filters[id] ?? '') : (active ?? '')}
                          onChange={(event) => {
                            const filters =
                              selection.filters ??
                              Object.fromEntries(
                                options.filters.flatMap(({ id, active }) =>
                                  active ? [[id, active]] : [],
                                ),
                              );
                            const value = event.currentTarget.value;
                            const next = { ...filters };
                            if (value) next[id] = value;
                            else delete next[id];
                            setSelection({ ...selection, filters: next, followDefault: false });
                          }}
                        >
                          <option value="">Use graph rules</option>
                          {choices.map(({ id, name }) => (
                            <option key={id} value={id}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  {options.outbounds.map(({ id, name, accepts }) => (
                    <PoolOutboundChoice
                      key={id}
                      name={name}
                      accepts={accepts}
                      entries={options.entries}
                      value={selection.outbounds?.[id]}
                      onChange={(link) => {
                        const outbounds = { ...selection.outbounds };
                        if (link) outbounds[id] = link;
                        else delete outbounds[id];
                        setSelection({ ...selection, outbounds, followDefault: false });
                      }}
                    />
                  ))}
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void run(() =>
                        inspect(
                          connected,
                          { graph: options.defaultGraph, followDefault: true },
                          selection.graph === options.defaultGraph,
                        ),
                      )
                    }
                  >
                    Use Pool defaults
                  </button>
                </>
              )}
            </>
          )}
          <p className="field-help">
            {singleRoute && complete
              ? 'Traffic will follow the route shown below.'
              : 'Choose a Pool route for each enabled local input.'}
          </p>
          <div className="item-list">
            {preview.inbounds.map((inbound) => (
              <label className="editor-field item-row" key={inbound.id}>
                <span>
                  {inbound.name} · {inbound.kind}
                  {inbound.endpoint && ` · ${inbound.endpoint}`}
                  {!inbound.enabled && ' · Disabled'}
                </span>
                {singleRoute && complete ? (
                  <small>
                    {preview.placeholders[0].name}
                    {preview.placeholders[0].destination &&
                      ` → ${preview.placeholders[0].destination}`}
                  </small>
                ) : (
                  <select
                    value={assignments[inbound.id] ?? ''}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPreview(
                        (current) =>
                          current && {
                            ...current,
                            bindings: { ...current.bindings, [inbound.id]: value },
                          },
                      );
                    }}
                  >
                    <option value="">
                      {inbound.enabled ? 'Choose a Pool route' : 'Unassigned'}
                    </option>
                    {preview.placeholders.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                        {entry.destination && ` → ${entry.destination}`}
                        {entry.ports.length > 1 &&
                          ` · ${entry.ports.map((port) => portLabel(port)).join(', ')}`}
                      </option>
                    ))}
                  </select>
                )}
                {Object.hasOwn(preview.bindings, inbound.id) &&
                  preview.bindings[inbound.id] &&
                  !known.has(preview.bindings[inbound.id]) && (
                    <small className="field-help">The previously assigned route was removed.</small>
                  )}
              </label>
            ))}
          </div>
          <button className="secondary-button" onClick={() => setPreview(undefined)}>
            Back
          </button>
          <button
            className="primary-button"
            disabled={!complete}
            onClick={() =>
              void run(async () => {
                const changes = {
                  capture: status?.connection ? 'current' : capture,
                  bindings: assignments,
                  expectedRevision: preview.revision,
                  expectedDigest: preview.digest,
                  selection: selection && {
                    ...selection,
                    ...(!connected && defaultChoice && { followDefault: true }),
                  },
                };
                if (status?.connection) await command('pool.bind', changes);
                else
                  await command('pool.enroll', {
                    ...changes,
                    source: source(),
                    start,
                    refreshMinutes,
                  });
                setPreview(undefined);
                setJustConnected(!connected);
                setInvite('');
                setIntervalDraft(undefined);
              })
            }
          >
            {status?.connection ? 'Apply choices' : 'Connect to Pool'}
          </button>
        </fieldset>
      ) : status?.connection ? (
        <fieldset disabled={busy || status.busy}>
          <legend>{status.connection.poolName ?? status.connection.name}</legend>
          {status.connection.poolName && status.connection.poolName !== status.connection.name && (
            <p className="field-help">Applied graph · {status.connection.name}</p>
          )}
          {justConnected && <p role="status">Connected. Your choices are saved.</p>}
          <button
            className={justConnected ? 'primary-button' : 'secondary-button'}
            disabled={testsBusy}
            onClick={() => void run(() => openGraph(true))}
          >
            Test connections
          </button>
          <p>{status.connection.address}</p>
          {intervalField}
          <button
            className="secondary-button"
            disabled={!intervalValid || refreshMinutes === status.connection.refreshMinutes}
            onClick={() =>
              void run(async () => {
                await command('pool.setInterval', { refreshMinutes });
                setIntervalDraft(undefined);
              })
            }
          >
            Save interval
          </button>
          <p className="field-help">
            {status.lastCheckAt
              ? `Last checked ${new Date(status.lastCheckAt).toLocaleString()}.`
              : 'Awaiting the first update check since the service started.'}
          </p>
          <p className="field-help">
            Pool choices last applied {new Date(status.connection.appliedAt).toLocaleString()}.
          </p>
          {checkResult && checkResult.at === status.lastCheckAt && !failure && !status.error && (
            <p role="status">{checkResult.message}</p>
          )}
          <p className="field-help">
            The service keeps the last working configuration if an update fails.
          </p>
          <button className="secondary-button" onClick={() => void run(checkNow)}>
            Check now
          </button>
          <button
            className={status.error ? 'primary-button' : 'secondary-button'}
            disabled={revision === undefined}
            onClick={() => void run(() => inspect(true))}
          >
            Edit configuration choices…
          </button>
          <button className="secondary-button" onClick={() => void run(() => openGraph())}>
            Open applied graph
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              setKeepStash(false);
              setDisconnect(true);
            }}
          >
            Disconnect
          </button>
        </fieldset>
      ) : (
        <fieldset disabled={!status || status.busy || busy}>
          <label className="editor-field">
            <span>Invitation or private access key</span>
            <input
              type="password"
              autoComplete="off"
              maxLength={100}
              value={invite}
              onChange={(event) => setInvite(event.currentTarget.value)}
              onPaste={(event) => {
                if (pasteInvitation(event.clipboardData.getData('text'))) {
                  event.preventDefault();
                  setFailure('');
                }
              }}
            />
            <small className="field-help">
              Paste the full invitation to fill in the source automatically. If you have only the
              private key, enter the folder or URL below.
            </small>
          </label>
          <label className="editor-field">
            <span>Source</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.currentTarget.value === 'url' ? 'url' : 'folder');
                setAddress('');
              }}
            >
              <option value="folder">Folder</option>
              <option value="url">URL</option>
            </select>
          </label>
          <label className="editor-field">
            <span>{kind === 'folder' ? 'Pool folder' : 'Pool folder URL'}</span>
            <input
              value={address}
              maxLength={2048}
              onChange={(event) => setAddress(event.currentTarget.value)}
            />
          </label>
          {kind === 'folder' && (
            <button
              className="secondary-button"
              onClick={() =>
                void run(async () => {
                  const chosen = await choosePoolFolder();
                  if (chosen) setAddress(chosen);
                })
              }
            >
              Choose folder…
            </button>
          )}
          <label className="editor-field">
            <span>Local capture</span>
            <select
              value={capture}
              onChange={(event) => setCapture(event.currentTarget.value as PoolCapture)}
            >
              <option value="current">Keep applied capture (local proxy if new)</option>
              <option value="proxy">Local proxy</option>
              <option value="tun">TUN</option>
            </select>
          </label>
          {intervalField}
          <label className="check-control">
            <input
              type="checkbox"
              checked={start}
              onChange={(event) => setStart(event.currentTarget.checked)}
            />
            Start routing after enrollment
          </label>
          <p className="field-help">
            Enrollment replaces the applied routing graph with the administrator’s graph. It also
            authorizes future routing, DNS and Stash updates from this Pool.
          </p>
          <button
            className="primary-button"
            disabled={!address.trim() || !invite.trim() || !intervalValid || revision === undefined}
            onClick={() => void run(() => inspect(false))}
          >
            Review Pool configuration
          </button>
        </fieldset>
      )}
      {busy || status?.busy ? (
        <p role="status" className="field-help">
          Checking Pool configuration…
        </p>
      ) : null}
      {(failure || statusError || status?.error) && (
        <p role="alert" className="notice notice--error">
          {failure || statusError || status?.error?.message}
        </p>
      )}
    </Dialog>
  );
}

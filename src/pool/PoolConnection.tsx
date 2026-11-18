import { useId, useRef, useState } from 'react';
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
import type { PoolBindings, PoolCapture, PoolEntries } from './model';
import type { Stash } from '../profiles/import';
import { portLabel } from '../graph/catalog';
import type { PoolOptions, PoolSelection } from './delivery';
import PoolOutboundChoice from './PoolOutboundChoice';
import { PoolSettingSummary } from './PoolSettingFields';
import type usePoolStatus from './usePoolStatus';
import { inviteLength, invitePattern, parsePoolInvitation, type PoolSource } from './invitation';
export type { PoolSource } from './invitation';

export type PoolPreview = PoolEntries & {
  digest: string;
  revision: number;
  selection?: PoolSelection;
  options?: PoolOptions;
};

export type PoolReview = {
  source: PoolSource;
  capture: PoolCapture;
  selection?: PoolSelection;
  bindings?: PoolBindings;
  expectedDigest?: string;
};
type Simulation = {
  user: string;
  source: PoolSource;
  inspect: (request: PoolReview) => Promise<PoolPreview>;
  prepare: (request: PoolReview) => Promise<{ graph: GraphState; stash: Stash }>;
  onPrepare: (workspace: { graph: GraphState; stash: Stash }) => void;
};
type LiveConnection = {
  poolStatus: ReturnType<typeof usePoolStatus>;
  revision: number | undefined;
  testsBusy: boolean;
  canReuseInbounds: boolean;
  onOpenGraph: (graph: GraphState) => void;
  onTestGraph: (graph: GraphState) => void;
  hasDifferentDraft: (graph: GraphState) => boolean;
  onOpenCaptureSettings: () => void;
};

const captureChoices = [
  { id: 'proxy', name: 'Proxy', help: 'For apps you point at the local proxy.' },
  { id: 'tun', name: 'TUN', help: 'Capture traffic from this computer.' },
  { id: 'both', name: 'Both', help: 'Use system-wide capture and a local proxy listener.' },
  {
    id: 'current',
    name: 'Keep existing inbounds',
    help: 'Reuse the capture and listeners in the applied graph.',
  },
] as const;

export default function PoolConnection({
  onClose,
  ...props
}: ({ live: LiveConnection } | { simulation: Simulation }) & { onClose: () => void }) {
  const live = 'live' in props ? props.live : undefined;
  const simulation = 'simulation' in props ? props.simulation : undefined;
  const { status, accept, error: statusError } = live?.poolStatus ?? {};
  const revision = live?.revision;
  const [kind, setKind] = useState<PoolSource['kind']>(simulation?.source.kind ?? 'folder');
  const [address, setAddress] = useState(simulation?.source.address ?? '');
  const [invite, setInvite] = useState(simulation?.source.invite ?? '');
  const [manual, setManual] = useState(false);
  const [capture, setCapture] = useState<PoolCapture>('proxy');
  const [start, setStart] = useState(true);
  const [preview, setPreview] = useState<PoolPreview & { capture: PoolCapture }>();
  const [customize, setCustomize] = useState(false);
  const [selection, setSelection] = useState<PoolSelection>();
  const [activity, setActivity] = useState('');
  const busy = !!activity;
  const [failure, setFailure] = useState('');
  const [justConnected, setJustConnected] = useState<{ proxy: string[] }>();
  const [disconnect, setDisconnect] = useState(false);
  const [keepStash, setKeepStash] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checkResult, setCheckResult] = useState<{ at?: number | null; message: string }>();
  const pending = useRef(false);
  const [intervalDraft, setIntervalDraft] = useState<string>();
  const captureFieldId = useId();
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
  async function run(action: () => Promise<void>, label = 'Working…') {
    if (pending.current) return;
    pending.current = true;
    setActivity(label);
    setFailure('');
    try {
      await action();
    } catch (reason) {
      setFailure(errorText(reason));
    } finally {
      pending.current = false;
      setActivity('');
    }
  }
  async function openGraph(test = false, confirmed = false) {
    if (!live) return;
    const result = await readSubscriptionDocument('applied');
    const graph = result.text && parseGraph(result.text);
    if (!graph || !graph.poolId) throw new Error('There is no applied Pool graph to open.');
    if (!test && !confirmed && live.hasDifferentDraft(graph)) {
      setConfirmOpen(true);
      return;
    }
    await refreshServiceStash();
    (test ? live.onTestGraph : live.onOpenGraph)(graph);
  }
  const source = () => ({ kind, address: address.trim(), invite: invite.trim() });
  function pasteInvitation(text: string) {
    const invitation = parsePoolInvitation(text);
    if (!invitation) return false;
    setKind(invitation.kind);
    setAddress(invitation.address);
    setInvite(invitation.invite);
    setManual(false);
    return true;
  }
  async function inspect(
    connected: boolean,
    choice?: PoolSelection,
    keepBindings = true,
    mode = preview?.capture ?? (connected ? 'current' : capture),
  ) {
    if (simulation) {
      const next = await simulation.inspect({
        source: source(),
        capture: mode,
        selection: choice,
        expectedDigest: choice ? preview?.digest : undefined,
        bindings: choice && keepBindings ? assignments : undefined,
      });
      setPreview({ ...next, capture: mode });
      setCapture(mode);
      setSelection(next.selection);
      if (!choice) setCustomize(false);
      return;
    }
    const { job } = await serviceCall<{ job: number }>('pool.preview', {
      ...(connected ? {} : { source: source() }),
      capture: mode,
      expectedRevision: revision,
      ...(preview
        ? {
            selection: choice,
            expectedDigest: preview.digest,
            ...(keepBindings ? { bindings: assignments } : {}),
          }
        : {}),
      ...(!keepBindings && { resetBindings: true }),
    });
    await waitSubscriptionJob(job);
    const next = await serviceCall<PoolPreview>('pool.previewResult', { job });
    setPreview({ ...next, capture: mode });
    if (!connected) setCapture(mode);
    setSelection(next.selection);
    if (!choice) setCustomize(connected);
  }

  async function command(method: string, params?: Record<string, unknown>) {
    const { job } = await serviceCall<{ job: number }>(method, params);
    await waitSubscriptionJob(job);
    const next = await readSubscriptionProgress<NonNullable<typeof status>>('pool.status');
    accept?.(next);
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
    (preview?.inbounds ?? []).flatMap(({ id, targets }) => {
      const target =
        preview && Object.hasOwn(preview.bindings, id) ? preview.bindings[id] : undefined;
      return target && (targets?.includes(target) ?? known.has(target)) ? [[id, target]] : [];
    }),
  );
  const complete = preview?.inbounds.every(
    ({ id, enabled }) => !enabled || Object.hasOwn(assignments, id),
  );
  const options = preview?.options;
  const customizationAvailable =
    !!options &&
    (options.stashes.length > 0 ||
      options.filters.some(({ choices }) => choices.length > 0) ||
      options.outbounds.some(({ accepts }) => accepts.length > 0));
  const connected = !!status?.connection;
  const defaultChoice =
    selection?.graph === options?.defaultGraph &&
    !selection?.stashes &&
    !selection?.filters &&
    !selection?.outbounds;
  const blocked = busy || !!status?.busy;
  const readyToReview =
    !!address.trim() &&
    invitePattern.test(invite.trim()) &&
    (!!simulation || (!!status && revision !== undefined));

  async function connect() {
    if (!preview || !complete || options?.reviewRequired) return;
    const changes = {
      capture: preview.capture,
      bindings: assignments,
      expectedRevision: preview.revision,
      expectedDigest: preview.digest,
      selection: selection && {
        ...selection,
        ...(!connected && defaultChoice && { followDefault: true }),
      },
    } as const;
    if (simulation) {
      simulation.onPrepare(await simulation.prepare({ ...changes, source: source() }));
      return;
    }
    if (connected) {
      await command('pool.bind', changes);
      setJustConnected(undefined);
    } else {
      if (!intervalValid) return;
      await command('pool.enroll', { ...changes, source: source(), start, refreshMinutes });
      setJustConnected({
        proxy: preview.inbounds.flatMap(({ kind, endpoint, enabled }) =>
          enabled && endpoint && kind === 'Proxy inbound' ? [endpoint] : [],
        ),
      });
    }
    setPreview(undefined);
    setInvite('');
    setIntervalDraft(undefined);
  }

  return (
    <Dialog
      title={
        confirmOpen
          ? 'Replace the open draft?'
          : disconnect
            ? 'Disconnect from Pool'
            : preview
              ? 'Review Pool configuration'
              : status?.connection
                ? 'Pool connection'
                : simulation
                  ? 'Test Pool invitation'
                  : 'Connect to Pool'
      }
      onClose={onClose}
      busy={busy}
      className="pool-dialog"
      footer={
        confirmOpen || disconnect ? (
          <></>
        ) : preview ? (
          <>
            <button
              className="secondary-button"
              disabled={blocked}
              onClick={() => {
                setPreview(undefined);
                setFailure('');
              }}
            >
              {connected ? 'Back to connection' : 'Back'}
            </button>
            <button
              className="primary-button"
              disabled={
                blocked ||
                !complete ||
                !!options?.reviewRequired ||
                (!connected && !simulation && !intervalValid)
              }
              onClick={() =>
                void run(
                  connect,
                  simulation ? 'Preparing the simulated graph…' : 'Applying Pool configuration…',
                )
              }
            >
              {simulation
                ? 'Open simulated graph'
                : connected
                  ? 'Apply choices'
                  : 'Connect to Pool'}
            </button>
          </>
        ) : connected ? undefined : (
          <>
            <button className="secondary-button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={blocked || !readyToReview}
              onClick={() => void run(() => inspect(false), 'Reading invitation…')}
            >
              Review configuration
            </button>
          </>
        )
      }
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
                  setJustConnected(undefined);
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
          <legend>Routing setup</legend>
          {options && selection && options.graphs.length > 1 ? (
            <label className="editor-field">
              <span>Graph for this computer</span>
              <select
                value={selection.graph}
                onChange={(event) => {
                  const graph = event.currentTarget.value;
                  void run(() => inspect(connected, { graph }, false), 'Loading graph…');
                }}
              >
                {options.graphs.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                    {id === options.defaultGraph ? ' (Pool default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>
              <strong>{preview.name}</strong>
            </p>
          )}
          <ul className="pool-route-summary" aria-label="Local routing">
            {preview.inbounds
              .filter(({ enabled }) => enabled)
              .map((inbound) => {
                const route = preview.placeholders.find(({ id }) => id === assignments[inbound.id]);
                return (
                  <li key={inbound.id}>
                    <strong>{inbound.name}</strong>
                    {inbound.endpoint && <span>{inbound.endpoint}</span>}
                    <span>
                      {route
                        ? `${route.name}${route.destination ? ` → ${route.destination}` : ''}`
                        : 'Choose an entry below'}
                    </span>
                  </li>
                );
              })}
          </ul>
          <details className="editor-advanced">
            <summary>Change local capture</summary>
            <label className="editor-field">
              <span>Capture mode</span>
              <select
                value={preview.capture}
                onChange={(event) => {
                  const mode = captureChoices.find(
                    ({ id }) => id === event.currentTarget.value,
                  )?.id;
                  if (mode)
                    void run(
                      () => inspect(connected, selection, false, mode),
                      'Checking capture choices…',
                    );
                }}
              >
                {captureChoices
                  .filter(({ id }) => id !== 'current' || connected || live?.canReuseInbounds)
                  .map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="field-help">
              Proxy, TUN and Both use standard local settings. Keep existing inbounds to preserve
              custom settings.
            </p>
          </details>
          {preview.settings && (
            <details className="editor-advanced">
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
              {customizationAvailable && (
                <button
                  className="secondary-button"
                  aria-expanded={customize}
                  onClick={() => setCustomize(!customize)}
                >
                  {customize ? 'Hide optional choices' : 'Customize layers and outbounds…'}
                </button>
              )}
              {customize && customizationAvailable && (
                <>
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
                            void run(() =>
                              inspect(connected, {
                                ...selection,
                                filters: next,
                                followDefault: false,
                              }),
                            );
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
                  {options.outbounds
                    .filter(({ accepts }) => accepts.length > 0)
                    .map(({ id, name, accepts }) => (
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
                          void run(() =>
                            inspect(connected, { ...selection, outbounds, followDefault: false }),
                          );
                        }}
                      />
                    ))}
                </>
              )}
              {(options.reviewRequired ||
                !defaultChoice ||
                (connected && !selection.followDefault)) && (
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
              )}
            </>
          )}
          {(!complete ||
            preview.inbounds.some(
              (inbound) => (inbound.targets?.length ?? preview.placeholders.length) > 1,
            )) && (
            <details className="editor-advanced" open={!complete || undefined}>
              <summary>Inbound assignments</summary>
              <div className="item-list">
                {preview.inbounds.map((inbound) => (
                  <label className="editor-field item-row" key={inbound.id}>
                    <span>
                      {inbound.name} · {inbound.kind}
                      {inbound.endpoint && ` · ${inbound.endpoint}`}
                      {!inbound.enabled && ' · Disabled'}
                    </span>
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
                      {preview.placeholders
                        .filter((entry) => inbound.targets?.includes(entry.id) ?? true)
                        .map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                            {entry.destination && ` → ${entry.destination}`}
                            {entry.ports.length > 1 &&
                              ` · ${entry.ports.map((port) => portLabel(port)).join(', ')}`}
                          </option>
                        ))}
                    </select>
                    {Object.hasOwn(preview.bindings, inbound.id) &&
                      preview.bindings[inbound.id] &&
                      !assignments[inbound.id] && (
                        <small className="field-help">
                          The previously assigned route is unavailable.
                        </small>
                      )}
                  </label>
                ))}
              </div>
            </details>
          )}
          {!connected && !simulation && (
            <>
              <p className="field-help">
                Connecting replaces the applied routing graph and allows future updates from this
                Pool.
              </p>
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={start}
                  onChange={(event) => setStart(event.currentTarget.checked)}
                />
                Start routing if stopped
              </label>
              <details className="editor-advanced">
                <summary>Update interval</summary>
                {intervalField}
                {!intervalValid && (
                  <p className="field-message error">
                    Enter a whole number from 1 to 1,440 minutes.
                  </p>
                )}
              </details>
            </>
          )}
        </fieldset>
      ) : status?.connection ? (
        <fieldset disabled={busy || status.busy}>
          <legend>{status.connection.poolName ?? status.connection.name}</legend>
          {status.connection.poolName && status.connection.poolName !== status.connection.name && (
            <p className="field-help">Applied graph · {status.connection.name}</p>
          )}
          {justConnected && (
            <div className="notice">
              <p role="status">Connected. This computer’s configuration is applied.</p>
              {!!justConnected.proxy.length && (
                <>
                  <p>
                    When routing is running, point your apps at {justConnected.proxy.join(' or ')}{' '}
                    to use the local proxy.
                  </p>
                  <button className="secondary-button" onClick={live?.onOpenCaptureSettings}>
                    Open Windows capture settings
                  </button>
                </>
              )}
            </div>
          )}
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
          <div className="pool-dialog-actions">
            <button
              className={justConnected ? 'primary-button' : 'secondary-button'}
              disabled={live?.testsBusy}
              onClick={() => void run(() => openGraph(true), 'Opening outbound tests…')}
            >
              Test outbounds
            </button>
            <button className="secondary-button" onClick={() => void run(() => openGraph())}>
              Open applied graph
            </button>
            <button
              className={status.error ? 'primary-button' : 'secondary-button'}
              disabled={revision === undefined}
              onClick={() => void run(() => inspect(true), 'Reading Pool configuration…')}
            >
              Edit configuration choices…
            </button>
            <button
              className="secondary-button"
              onClick={() => void run(checkNow, 'Checking for updates…')}
            >
              Check for updates
            </button>
          </div>
          <details className="editor-advanced">
            <summary>Connection settings</summary>
            <p className="field-help">{status.connection.address}</p>
            {intervalField}
            <div className="pool-dialog-actions">
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
              <button
                className="secondary-button"
                onClick={() => {
                  setKeepStash(false);
                  setDisconnect(true);
                }}
              >
                Disconnect…
              </button>
            </div>
          </details>
        </fieldset>
      ) : (
        <>
          <fieldset disabled={blocked}>
            <legend>Invitation</legend>
            {simulation ? (
              <p>
                <strong>{simulation.user}</strong> · {address}
              </p>
            ) : (
              <>
                <label className="editor-field">
                  <span>Invitation or private access key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    maxLength={inviteLength}
                    value={invite}
                    autoFocus
                    placeholder="Paste the invitation you received"
                    onChange={(event) => {
                      setInvite(event.currentTarget.value);
                      if (!address && invitePattern.test(event.currentTarget.value.trim()))
                        setManual(true);
                    }}
                    onPaste={(event) => {
                      if (pasteInvitation(event.clipboardData.getData('text'))) {
                        event.preventDefault();
                        setFailure('');
                      }
                    }}
                  />
                </label>
                {!manual && address && <p className="field-help">Invitation source · {address}</p>}
                <button
                  className="secondary-button"
                  aria-expanded={manual}
                  onClick={() => setManual(!manual)}
                >
                  {manual
                    ? 'Hide source details'
                    : address
                      ? 'Edit invitation source…'
                      : 'Enter folder or URL manually…'}
                </button>
                {manual && (
                  <>
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
                          }, 'Choosing a Pool folder…')
                        }
                      >
                        Choose folder…
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </fieldset>
          <fieldset disabled={blocked}>
            <legend>How should Wayrill capture traffic?</legend>
            <div className="pool-capture-choices">
              {captureChoices
                .filter(({ id }) => id !== 'current' || live?.canReuseInbounds)
                .map(({ id, name, help }) => (
                  <label key={id} className="pool-capture-choice">
                    <input
                      type="radio"
                      name={captureFieldId}
                      value={id}
                      checked={capture === id}
                      onChange={() => setCapture(id)}
                    />
                    <span>
                      <strong>{name}</strong>
                      <small>{help}</small>
                    </span>
                  </label>
                ))}
            </div>
          </fieldset>
          {simulation && (
            <p className="field-help">
              You can inspect the subscriber’s graph without starting routing or changing this
              computer’s settings.
            </p>
          )}
        </>
      )}
      {busy || status?.busy ? (
        <p role="status" className="field-help">
          {activity || 'Applying a Pool update…'}
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

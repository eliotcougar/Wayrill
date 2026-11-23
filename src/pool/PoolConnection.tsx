import { useId, useRef, useState } from 'react';
import Dialog from '../components/Dialog';
import './pool.css';
import { parseGraph } from '../graph/model';
import { ownValue } from '../graph/xrayJson';
import { exportFile } from '../exportFile';
import { protectedRead } from '../protectedStorage';
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
import type { PoolApplicationChanges } from '../graph/applications';
import { PoolApplicationBindingEditor } from './PoolApplications';
import type { Stash } from '../profiles/import';
import { portLabel } from '../graph/catalog';
import type { PoolOptions, PoolSelection } from './delivery';
import PoolOutboundChoice from './PoolOutboundChoice';
import type { PoolPreferenceResets } from './preferences';
import { PoolSettingSummary } from './PoolSettingFields';
import type usePoolStatus from './usePoolStatus';
import { inviteLength, invitePattern, parsePoolInvitation, type PoolSource } from './invitation';
export type { PoolSource } from './invitation';

export type PoolPreview = PoolEntries & {
  personalSettings?: { nodeId: string; node: string; key: string; field: string }[];
  digest: string;
  revision: number;
  sourceHash?: string;
  selection?: PoolSelection;
  options?: PoolOptions;
};

export type PoolReview = {
  source: PoolSource;
  capture: PoolCapture;
  selection?: PoolSelection;
  bindings?: PoolBindings;
  applicationChanges?: PoolApplicationChanges;
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
  onShowGraph: () => void;
  onChoicesApplied: () => void;
  showingApplied: boolean;
  hasPrevious: boolean;
  editorError: string;
  onTestGraph: (graph: GraphState) => void;
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
  const [resets, setResets] = useState<PoolPreferenceResets>({});
  const [applicationChanges, setApplicationChanges] = useState<PoolApplicationChanges>({});
  const [justConnected, setJustConnected] = useState<{ proxy: string[] }>();
  const [disconnect, setDisconnect] = useState(false);
  const [keepStash, setKeepStash] = useState(false);
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
  async function testAppliedGraph() {
    if (!live) return;
    const result = await readSubscriptionDocument('applied');
    const graph = result.text && parseGraph(result.text);
    if (!graph || !graph.poolId) throw new Error('There is no applied Pool graph to open.');
    await refreshServiceStash();
    live.onTestGraph(graph);
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
    latest = false,
    useDefaults = false,
  ) {
    if (simulation) {
      const next = await simulation.inspect({
        source: source(),
        capture: mode,
        selection: choice,
        expectedDigest: choice && !latest ? preview?.digest : undefined,
        bindings: choice && keepBindings ? assignments : undefined,
      });
      setPreview({ ...next, capture: mode });
      if (!preview) setApplicationChanges({});
      setCapture(mode);
      setSelection(next.selection);
      if (!choice) setCustomize(false);
      return;
    }
    const { job } = await serviceCall<{ job: number }>('pool.preview', {
      ...(connected ? {} : { source: source() }),
      capture: mode,
      expectedRevision: !latest && preview ? preview.revision : revision,
      expectedSourceHash: latest ? undefined : preview?.sourceHash,
      ...(preview
        ? {
            selection: choice,
            expectedDigest: latest ? undefined : preview.digest,
            ...(keepBindings ? { bindings: assignments } : {}),
          }
        : {}),
      ...(!keepBindings && { resetBindings: true }),
      ...(useDefaults && { useDefaults: true }),
    });
    await waitSubscriptionJob(job);
    const next = await serviceCall<PoolPreview>('pool.previewResult', { job });
    setPreview({ ...next, capture: mode });
    if (!preview) setApplicationChanges({});
    if (!preview || preview.selection?.graph !== next.selection?.graph || latest) setResets({});
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
      const target = ownValue(preview?.bindings, id);
      return target && (targets?.includes(target) ?? known.has(target)) ? [[id, target]] : [];
    }),
  );
  const complete = preview?.inbounds.every(
    ({ id, enabled }) => !enabled || Object.hasOwn(assignments, id),
  );
  const applicationChoiceMissing = preview?.applications?.some(
    ({ id, requireLocal, binding, detection }) =>
      requireLocal &&
      !detection?.path &&
      !(Object.hasOwn(applicationChanges, id) ? applicationChanges[id] : binding),
  );
  const options = preview?.options;
  // Older enrollments selected entire lists. Keep their explicit choices until
  // the subscriber chooses which entries should follow future defaults.
  const legacyStashes = selection?.stashes && new Set(selection.stashes);
  const stashPreferences = legacyStashes
    ? Object.fromEntries((options?.stashes ?? []).map(({ id }) => [id, legacyStashes.has(id)]))
    : (selection?.stashOverrides ?? {});
  const filterPreferences = selection?.filters
    ? Object.fromEntries(
        (options?.filters ?? []).map(({ id }) => [id, ownValue(selection.filters, id) ?? null]),
      )
    : (selection?.filterOverrides ?? {});
  const customizationAvailable =
    !!options &&
    (options.stashes.length > 0 ||
      options.filters.some(({ choices, defaultLayer }) => choices.length > 0 || !!defaultLayer) ||
      options.outbounds.some(({ accepts }) => accepts.length > 0));
  const connected = !!status?.connection;
  const recovering = !!status?.recovering;
  const defaultChoice =
    selection?.graph === options?.defaultGraph &&
    !selection?.stashes &&
    !selection?.filters &&
    !Object.keys(selection?.outbounds ?? {}).length &&
    !Object.keys(selection?.stashOverrides ?? {}).length &&
    !Object.keys(selection?.filterOverrides ?? {}).length;
  const blocked = busy || !!status?.busy || recovering;
  const readyToReview =
    !!address.trim() &&
    invitePattern.test(invite.trim()) &&
    (!!simulation || (!!status && revision !== undefined));

  async function connect() {
    if (!preview || !complete || applicationChoiceMissing || options?.reviewRequired) return;
    const changes = {
      capture: preview.capture,
      bindings: assignments,
      expectedRevision: preview.revision,
      expectedSourceHash: preview.sourceHash,
      expectedDigest: preview.digest,
      selection,
      ...(Object.keys(applicationChanges).length ? { applicationChanges } : {}),
    } as const;
    if (simulation) {
      simulation.onPrepare(await simulation.prepare({ ...changes, source: source() }));
      return;
    }
    if (connected) {
      await command('pool.bind', {
        ...changes,
        ...(Object.keys(resets).length && { resetPreferences: resets }),
      });
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
    live?.onChoicesApplied();
    setPreview(undefined);
    setCapture('current');
    setInvite('');
    setIntervalDraft(undefined);
  }

  return (
    <Dialog
      title={
        disconnect
          ? 'Disconnect from Pool'
          : preview
            ? 'Review Pool configuration'
            : status?.connection
              ? 'Pool connection'
              : recovering
                ? 'Pool recovery'
                : simulation
                  ? 'Test Pool invitation'
                  : 'Connect to Pool'
      }
      onClose={onClose}
      busy={busy}
      className="pool-dialog"
      footer={
        disconnect ? (
          <></>
        ) : preview ? (
          <>
            <button
              className="secondary-button"
              disabled={busy || status?.busy}
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
                !!applicationChoiceMissing ||
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
        ) : connected || recovering ? undefined : (
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
      {disconnect ? (
        <fieldset disabled={busy || status?.busy}>
          <legend>
            {status?.connection?.poolName ?? status?.connection?.name ?? 'Pending connection'}
          </legend>
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
                  setCapture('proxy');
                  setIntervalDraft(undefined);
                })
              }
            >
              Disconnect
            </button>
          </div>
        </fieldset>
      ) : recovering && !connected ? (
        <div className="notice">
          <p>Wayrill is waiting to verify the last Pool configuration against the applied graph.</p>
          <button className="secondary-button" disabled={busy} onClick={() => setDisconnect(true)}>
            Disconnect…
          </button>
        </div>
      ) : preview ? (
        <fieldset disabled={busy || status?.busy}>
          <legend>Routing setup</legend>
          {options && selection ? (
            <label className="editor-field">
              <span>Graph for this computer</span>
              <select
                value={selection.followDefault ? '@default' : selection.graph}
                onChange={(event) => {
                  const graph = event.currentTarget.value;
                  const followDefault = graph === '@default';
                  const target = followDefault ? options.defaultGraph : graph;
                  const choice = {
                    ...(target === selection.graph && !followDefault
                      ? selection
                      : {
                          stashes: selection.stashes,
                          stashOverrides: selection.stashOverrides,
                          deviceLayers: selection.deviceLayers,
                        }),
                    graph: target,
                    followDefault,
                  };
                  void run(
                    () => inspect(connected, choice, choice.graph === selection.graph),
                    'Loading graph…',
                  );
                }}
              >
                <option value="@default">
                  Follow Pool default ·{' '}
                  {options.graphs.find((g) => g.id === options.defaultGraph)?.name}
                </option>
                {options.graphs.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
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
                const target = ownValue(assignments, inbound.id);
                const route = preview.placeholders.find(({ id }) => id === target);
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
          {!!preview.applications?.length && (
            <PoolApplicationBindingEditor
              applications={preview.applications}
              changes={applicationChanges}
              onChange={(id, binding) =>
                setApplicationChanges((current) => ({ ...current, [id]: binding }))
              }
            />
          )}
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
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void run(() => inspect(connected, selection), 'Reviewing remaining choices…')
                    }
                  >
                    Review with available choices
                  </button>
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
                        <label key={id} className="editor-field">
                          <span>{name}</span>
                          <select
                            value={
                              Object.hasOwn(stashPreferences, id)
                                ? stashPreferences[id]
                                  ? 'include'
                                  : 'exclude'
                                : ''
                            }
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              const next = { ...stashPreferences, [id]: value === 'include' };
                              if (!value) delete next[id];
                              void run(() =>
                                inspect(connected, {
                                  ...selection,
                                  stashes: undefined,
                                  stashOverrides: next,
                                }),
                              );
                            }}
                          >
                            <option value="">
                              Follow Pool ·{' '}
                              {(options.defaultStashes ?? options.activeStashes).includes(id)
                                ? 'included'
                                : 'optional'}
                            </option>
                            <option value="include">Include on this computer</option>
                            <option value="exclude">Exclude on this computer</option>
                          </select>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {options.filters
                    .filter(({ choices, defaultLayer }) => choices.length || defaultLayer)
                    .map(({ id, name, choices, defaultLayer }) => (
                      <label className="editor-field" key={id}>
                        <span>{name}</span>
                        <select
                          value={
                            Object.hasOwn(filterPreferences, id)
                              ? (filterPreferences[id] ?? '@rules')
                              : ''
                          }
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            const next = {
                              ...filterPreferences,
                              [id]: value === '@rules' ? null : value,
                            };
                            if (!value) delete next[id];
                            void run(() =>
                              inspect(connected, {
                                ...selection,
                                filters: undefined,
                                filterOverrides: next,
                                followDefault: false,
                              }),
                            );
                          }}
                        >
                          <option value="">
                            Follow Pool ·{' '}
                            {defaultLayer
                              ? (choices.find((c) => c.id === defaultLayer)?.name ??
                                'unavailable filter')
                              : 'graph rules'}
                          </option>
                          <option value="@rules">Always use graph rules</option>
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
                        value={ownValue(selection.outbounds, id)}
                        onChange={(link) => {
                          const outbounds = new Map(Object.entries(selection.outbounds ?? {}));
                          if (link) outbounds.set(id, link);
                          else outbounds.delete(id);
                          void run(() =>
                            inspect(connected, {
                              ...selection,
                              outbounds: Object.fromEntries(outbounds),
                              followDefault: false,
                            }),
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
                        {
                          graph: options.defaultGraph,
                          followDefault: true,
                          deviceLayers: selection.deviceLayers,
                        },
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
          {!!options?.deviceLayers?.length && selection && (
            <fieldset className="pool-assignments" disabled={busy}>
              <legend>Optional Windows settings</legend>
              <p className="field-help">
                Choose which layers to apply on this PC. Your choices carry over to future Pool
                updates.
              </p>
              {options.deviceLayers.map(({ id, name, data }) => (
                <div className="pool-assignment" key={id}>
                  <label className="check-control">
                    <input
                      type="checkbox"
                      checked={selection.deviceLayers?.includes(id) ?? false}
                      onChange={(event) => {
                        const selected = new Set(selection.deviceLayers);
                        if (event.currentTarget.checked) selected.add(id);
                        else selected.delete(id);
                        setSelection({ ...selection, deviceLayers: [...selected] });
                      }}
                    />
                    <span>
                      {name}{' '}
                      <small>
                        {data.kind === 'loopback' ? 'Loopback exemptions' : 'App protection'}
                      </small>
                    </span>
                  </label>
                  <details className="editor-advanced">
                    <summary>Review targets</summary>
                    {data.kind === 'app-protection' && !data.protection.enabled ? (
                      <p className="field-help">
                        This layer currently supplies no active protection.
                      </p>
                    ) : (
                      <ul>
                        {(data.kind === 'loopback'
                          ? data.packages
                          : data.protection.applications.map(({ value }) => value)
                        ).map((value) => (
                          <li key={value} className="field-help">
                            {value}
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                </div>
              ))}
            </fieldset>
          )}
          {!!preview.personalSettings?.length && (
            <details className="editor-advanced">
              <summary>Personal node settings ({preview.personalSettings.length})</summary>
              <p className="field-help">
                Checked settings keep your value as this graph updates. Clear a setting and apply
                your choices to use the Pool value again.
              </p>
              {preview.personalSettings.map(({ nodeId, node, key, field }) => (
                <label key={JSON.stringify([nodeId, key])} className="check-control">
                  <input
                    type="checkbox"
                    checked={!Object.hasOwn(resets, nodeId) || !resets[nodeId].includes(key)}
                    onChange={(event) => {
                      const keep = event.currentTarget.checked;
                      setResets((current) => {
                        const keys = Object.hasOwn(current, nodeId) ? current[nodeId] : [];
                        return {
                          ...current,
                          [nodeId]: keep ? keys.filter((k) => k !== key) : [...keys, key],
                        };
                      });
                    }}
                  />
                  {node} · {field}
                </label>
              ))}
            </details>
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
                      value={ownValue(assignments, inbound.id) ?? ''}
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
                    {ownValue(preview.bindings, inbound.id) &&
                      !Object.hasOwn(assignments, inbound.id) && (
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
              onClick={() => void run(testAppliedGraph, 'Opening outbound tests…')}
            >
              Test outbounds
            </button>
            {!live?.showingApplied && (
              <button className="secondary-button" onClick={live?.onShowGraph}>
                Show applied Pool graph
              </button>
            )}
            <button
              className={status.error ? 'primary-button' : 'secondary-button'}
              disabled={revision === undefined || recovering}
              onClick={() => void run(() => inspect(true), 'Reading Pool configuration…')}
            >
              Edit configuration choices…
            </button>
            <button
              className="secondary-button"
              disabled={recovering}
              onClick={() => void run(checkNow, 'Checking for updates…')}
            >
              Check for updates
            </button>
          </div>
          {status.connection.personalSettings && (
            <p className="field-help">
              You can change local capture, Global defaults, DNS and probe settings, and add
              personal Before or After traffic rules while continuing to receive Pool updates. Use
              Edit configuration choices to change your graph, filters or outbounds.
            </p>
          )}
          <details className="editor-advanced">
            <summary>Connection settings</summary>
            <p className="field-help">{status.connection.address}</p>
            <p className="field-help">Pool updates keep existing inbounds and their assignments.</p>
            {intervalField}
            <div className="pool-dialog-actions">
              {live?.hasPrevious && (
                <button
                  className="secondary-button"
                  onClick={() =>
                    void run(async () => {
                      const text = await protectedRead('pool-previous');
                      if (!text) throw new Error('The previous local graph is unavailable.');
                      await exportFile('previous-local-graph.wayrill.json', text);
                    }, 'Opening previous local graph…')
                  }
                >
                  Export previous local graph…
                </button>
              )}
              <button
                className="secondary-button"
                disabled={
                  recovering ||
                  !intervalValid ||
                  refreshMinutes === status.connection.refreshMinutes
                }
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
          {activity || (status?.applying ? 'Applying Pool configuration…' : 'Checking Pool…')}
        </p>
      ) : recovering && connected ? (
        <p role="status" className="field-help">
          Waiting to verify the last Pool update. The current configuration remains available.
        </p>
      ) : null}
      {(failure || statusError || (!preview && status?.error) || live?.editorError) && (
        <p role="alert" className="notice notice--error">
          {failure || statusError || (!preview && status?.error?.message) || live?.editorError}
        </p>
      )}
      {status?.deviceErrors?.map(({ message }) => (
        <p key={message} role="alert" className="notice notice--error">
          {message}
        </p>
      ))}
      {preview && (failure || (revision !== undefined && revision !== preview.revision)) && (
        <button
          className="secondary-button"
          disabled={blocked}
          onClick={() =>
            void run(
              () => inspect(connected, selection, true, preview.capture, true),
              'Reading the latest delivery…',
            )
          }
        >
          Review latest delivery
        </button>
      )}
      {connected && !preview && !disconnect && failure && (
        <div className="pool-dialog-actions">
          <button
            className="secondary-button"
            disabled={blocked}
            onClick={() =>
              void run(
                () => inspect(true, undefined, false, 'current', true, true),
                'Reading Pool defaults…',
              )
            }
          >
            Review Pool defaults with existing inbounds
          </button>
          {captureChoices
            .filter(({ id }) => id === 'proxy' || id === 'tun')
            .map(({ id, name }) => (
              <button
                key={id}
                className="secondary-button"
                disabled={blocked}
                onClick={() =>
                  void run(
                    () => inspect(true, undefined, false, id, true, true),
                    'Reviewing capture…',
                  )
                }
              >
                Review with {name}
              </button>
            ))}
        </div>
      )}
    </Dialog>
  );
}

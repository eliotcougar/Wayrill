import RuntimeProgressOverlay from './RuntimeProgressOverlay';
import { runtimeProgress } from '../runtimeProgress';
import { coreResourceFailure } from '../graph/coreValidationDiagnostics';
import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import useModalDialog from './useModalDialog';
import DiagnosticList from './DiagnosticNavigation';
import GraphCheckDialog from './GraphCheckDialog';
import ResourceWarnings from './ResourceWarnings';
import type { Diagnostic } from '../graph/types';
import { useRef, useState } from 'react';
import { Play, Square, RefreshCw, X, Server, ShieldCheck } from 'lucide-react';
import { errorText } from '../serviceClient';
import type { RuntimeController } from '../useRuntime';
import useGraphAnalysis from '../useGraphAnalysis';
import createGraphRuntimeActions, { type GraphRuntimeActions } from '../createGraphRuntimeActions';
import { runtimePresentation } from '../runtimePresentation';
import type { GraphState } from '../graph/types';
type Props = {
  graph: GraphState;
  analysis?: ReturnType<typeof useGraphAnalysis>;
  runtime: RuntimeController;
  actions?: GraphRuntimeActions;
  onIssue: (issue: Diagnostic) => void;
  onClose: () => void;
  onSystemCapture?: () => void;
  onResources?: () => void;
};
export default function RuntimePanel(props: Props) {
  return props.actions ? (
    <RuntimePanelView {...props} actions={props.actions} />
  ) : (
    <StandaloneRuntimePanel {...props} />
  );
}
function StandaloneRuntimePanel(props: Props) {
  const local = useGraphAnalysis(props.graph, !props.analysis);
  const actions = createGraphRuntimeActions(props.graph, props.analysis ?? local, props.runtime);
  return <RuntimePanelView {...props} actions={actions} />;
}
function RuntimePanelView({
  graph,
  runtime,
  actions,
  onIssue,
  onClose,
  onSystemCapture,
  onResources,
}: Props & { actions: GraphRuntimeActions }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'overview' | 'events'>('overview');
  const { snapshot, connected, busy, error, notice, events, desktop } = runtime;
  const {
    checks,
    compiled,
    errors,
    canStop,
    canApply,
    captureAvailable,
    captureOwnership,
    ownershipUnavailable,
    activationAvailable,
    nativeAvailable,
    observationAvailable,
    protocolAvailable,
    capacityAvailable,
    adapterAvailable,
  } = actions;
  const issues = checks.issues;
  const [checkOpen, setCheckOpen] = useState(false);
  const view = runtimePresentation(runtime, compiled);
  const running = view.running;
  const ownershipExplains = (message: string | null | undefined) =>
    ownershipUnavailable &&
    !!message &&
    message.replace(/^WINDIVERT_CONFLICT:\s*/, '') === captureOwnership?.message;
  const visibleCommandError = !!error && !ownershipExplains(error);
  const resourceFailure = coreResourceFailure(
    graph,
    error || snapshot?.core.lastError?.message || '',
  );
  useModalDialog(dialog);
  const tabs = useEditorTabs(
    [
      { key: 'overview', label: 'Runtime' },
      { key: 'events', label: `Events (${events.length})` },
    ],
    tab,
    setTab,
  );
  return (
    <>
      <dialog
        ref={dialog}
        className="rule-editor-window runtime-window"
        onClose={onClose}
        aria-labelledby="runtime-title"
      >
        <div className="rule-editor-titlebar">
          <div>
            <h2 id="runtime-title">
              <Server size={19} /> Run graph
            </h2>
          </div>
          <button className="icon-button" aria-label="Close Run graph" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <EditorTabs tabs={tabs} label="Run graph sections">
          <span className={`runtime-connection ${connected ? 'online' : ''}`}>
            {connected
              ? `Connected · v${snapshot?.serviceVersion ?? ''}`
              : desktop
                ? 'Service offline'
                : 'Desktop app required'}
          </span>
        </EditorTabs>
        <RuntimeProgressOverlay progress={runtimeProgress(runtime)}>
          <EditorTabPanels tabs={tabs} className="runtime-body">
            {!desktop && (
              <div className="notice">
                The browser can check and compile graphs. Run controls require Wayrill for Windows.
              </div>
            )}
            {desktop && !connected && (
              <div className="notice">
                The networking service is unavailable. Current runtime state is unknown; the last
                known state may have changed. Install or start the service, then refresh.
              </div>
            )}
            {compiled?.capture && (
              <div className="notice">
                Draft local capture: {compiled.capture.inputs.length} sources.
              </div>
            )}
            {connected && !captureAvailable && (
              <div className="notice notice--error" role="alert">
                Update the networking service to run these local capture conditions.
              </div>
            )}
            {connected && ownershipUnavailable && captureOwnership && (
              <div className="notice notice--error" role="alert">
                <strong>
                  {captureOwnership.state === 'blocked'
                    ? 'WinDivert is in use'
                    : 'WinDivert ownership could not be verified'}
                </strong>
                <br />
                {captureOwnership.message ||
                  'Wayrill capture remains off. Refresh before trying again.'}
              </div>
            )}
            {connected && snapshot?.capture?.firewallRecoveryError && (
              <div className="notice notice--error" role="alert">
                {snapshot.capture.firewallRecoveryError}
              </div>
            )}
            {connected && (snapshot?.appProtection?.blocked || snapshot?.appProtection?.error) && (
              <div className="notice" role="status">
                {snapshot.appProtection.blocked &&
                  'Selected applications are blocked until routing recovers. Stop releases protection.'}
                {snapshot.appProtection.error && (
                  <p role="alert">{snapshot.appProtection.error.message}</p>
                )}
              </div>
            )}
            {connected &&
              snapshot?.capture?.lastError &&
              !ownershipExplains(snapshot.capture.lastError) &&
              snapshot.capture.lastError !== snapshot.core.lastError?.message && (
                <div className="notice notice--error" role="alert">
                  <strong>
                    {snapshot.capture.state === 'failed'
                      ? 'Capture failure'
                      : 'Previous capture failure'}
                  </strong>
                  <br />
                  {snapshot.capture.lastError}
                </div>
              )}
            {connected && !activationAvailable && (
              <div className="notice">Update the Wayrill service to enable this action.</div>
            )}
            {connected && !nativeAvailable && (
              <div className="notice">
                Install the matching Wayrill service to run imported configurations.
              </div>
            )}
            {connected && !observationAvailable && (
              <div className="notice">
                Install the matching Wayrill service to run graphs with an observatory.
              </div>
            )}
            {connected && !capacityAvailable && (
              <p className="notice notice--error" role="alert">
                Update the networking service to run this graph at the required capacity.
              </p>
            )}
            {connected && !protocolAvailable && (
              <div className="notice">
                Install the matching Wayrill service to use this graph’s protocols.
              </div>
            )}
            {!adapterAvailable && (
              <div className="notice">Update the networking service to run TUN capture.</div>
            )}
            {actions.setupOutbounds.length > 0 && (
              <div className="notice">
                Replace the example outbound with a working profile in Stash before starting.
              </div>
            )}
            {resourceFailure && (
              <div className="notice notice--error" role="alert">
                <p>{resourceFailure.message}</p>
                <DiagnosticList issues={resourceFailure.issues} onIssue={onIssue} />
                {onResources && (
                  <button className="secondary-button" onClick={onResources}>
                    Resource files…
                  </button>
                )}
              </div>
            )}
            {visibleCommandError && (
              <div className="notice notice--error" role="alert">
                {runtime.errorAction && (
                  <>
                    <strong>
                      Last command:{' '}
                      {runtime.errorAction === 'config.applyAndStart'
                        ? 'Apply'
                        : runtime.errorAction === 'config.validate'
                          ? 'Validate submitted configuration'
                          : runtime.errorAction === 'config.apply'
                            ? 'Apply submitted configuration'
                            : runtime.errorAction}
                    </strong>
                    <br />
                  </>
                )}
                {resourceFailure ? (
                  <details className="disclosure">
                    <summary>Core diagnostics</summary>
                    <pre className="code-block" tabIndex={0}>
                      {error}
                    </pre>
                  </details>
                ) : (
                  error
                )}
              </div>
            )}
            {connected && snapshot?.recovery?.state === 'waiting' && (
              <div className="notice" role="status">
                {snapshot.recovery.desiredState === 'running'
                  ? 'Recovering routing automatically…'
                  : snapshot.recovery.desiredState === 'unknown'
                    ? 'Waiting for trusted recovery state…'
                    : 'Finishing system restoration automatically…'}
              </div>
            )}
            {connected && snapshot?.recovery?.state === 'blocked' && (
              <div className="notice notice--warning" role="status">
                <strong>Recovery needs attention</strong>
                <p>{snapshot.recovery.lastError?.message}</p>
              </div>
            )}
            {connected && snapshot?.userSettings?.lastError ? (
              <div className="notice notice--warning" role="status">
                <strong>User proxy settings need attention</strong>
                <p>{snapshot.userSettings.lastError.message}</p>
              </div>
            ) : connected && snapshot?.userSettings?.waitingForUser ? (
              <div className="notice" role="status">
                User proxy settings will resume after sign-in.
              </div>
            ) : null}
            {connected && snapshot?.config.recoveryError && (
              <div className="notice notice--error" role="alert">
                <strong>Saved configuration needs recovery</strong>
                <br />
                {snapshot.config.recoveryError.message}
              </div>
            )}
            {!visibleCommandError &&
              connected &&
              snapshot?.core.lastError &&
              snapshot.core.lastError.message !== snapshot.config.recoveryError?.message &&
              !ownershipExplains(snapshot.core.lastError.message) && (
                <div className="notice notice--error" role="alert">
                  <strong>
                    {snapshot.core.state === 'failed' ? 'Core failure' : 'Previous core failure'}
                  </strong>
                  <br />
                  {resourceFailure ? (
                    <details className="disclosure">
                      <summary>Core diagnostics</summary>
                      <pre className="code-block" tabIndex={0}>
                        {snapshot.core.lastError.message}
                      </pre>
                    </details>
                  ) : (
                    snapshot.core.lastError.message
                  )}
                </div>
              )}
            {connected && (
              <ResourceWarnings report={snapshot?.resources} onResources={onResources} compact />
            )}
            {connected && notice && (
              <div className="notice notice--success" role="status">
                <strong>Last completed action</strong>
                <br />
                {notice}
              </div>
            )}
            {tab === 'overview' ? (
              <>
                <div className="runtime-cards">
                  <div className="editor-panel editor-panel--outlined">
                    <span>Xray core</span>
                    <strong className={running ? 'online' : ''}>{view.core.value}</strong>
                    {(view.current || (desktop && snapshot)) && <small>{view.core.detail}</small>}
                  </div>
                  <div className="editor-panel editor-panel--outlined">
                    <span>Applied configuration</span>
                    <strong>{view.applied.value}</strong>
                    {!view.current && desktop && snapshot?.config.present && (
                      <small>{view.applied.detail}</small>
                    )}
                  </div>
                  <div className="editor-panel editor-panel--outlined">
                    <span>Windows proxy</span>
                    <strong>{view.proxy.value}</strong>
                    {view.current && <small>{view.proxy.detail}</small>}
                  </div>
                  <div className="editor-panel editor-panel--outlined">
                    <span>WinDivert capture</span>
                    <strong>{view.capture.value}</strong>
                    {view.current && <small>{view.capture.detail}</small>}
                  </div>
                  {snapshot?.tun &&
                    (snapshot.tun.state === 'running' ||
                      compiled?.summary.listeners.some((i) => i.protocol === 'tun')) && (
                      <div className="editor-panel editor-panel--outlined">
                        <span>TUN capture</span>
                        <strong>
                          {snapshot.network?.state === 'waiting'
                            ? 'Waiting for uplink'
                            : snapshot.network?.state === 'settling' ||
                                snapshot.network?.state === 'reconnecting'
                              ? 'Reconnecting'
                              : snapshot.tun.state}
                        </strong>
                        {snapshot.network?.lastError && (
                          <small>{snapshot.network.lastError.message}</small>
                        )}
                        {snapshot.tun.name && (
                          <small>
                            {snapshot.tun.name} · {snapshot.tun.uplink}
                          </small>
                        )}
                      </div>
                    )}
                </div>
                <p className="notice">
                  {checks.pending
                    ? 'Checking graph…'
                    : errors.length
                      ? `${errors.length} graph issues prevent starting`
                      : view.draftState}
                </p>
                {compiled && (
                  <section className="runtime-section">
                    <h3>Draft preview · {graph.name}</h3>
                    <p>
                      {compiled.summary.listeners
                        .map((i) =>
                          i.protocol === 'tun'
                            ? 'TUN adapter'
                            : `${i.protocol.toUpperCase()} ${i.address}:${i.port}`,
                        )
                        .join(' · ')}
                    </p>
                    <p>
                      {compiled.summary.outboundCount} destinations ·{' '}
                      {compiled.summary.trafficRuleCount} routing rules ·{' '}
                      {compiled.summary.dnsServerCount} DNS servers.
                    </p>
                  </section>
                )}
                <div className="action-row runtime-actions">
                  <button className="secondary-button" onClick={() => setCheckOpen(true)}>
                    Check
                  </button>
                  <button
                    className="primary-button"
                    disabled={!canApply}
                    title={actions.applyReason || actions.activationTitle}
                    onClick={() => void actions.activate().catch(() => {})}
                  >
                    {actions.activationLabel === 'Restart' ? (
                      <RefreshCw size={15} />
                    ) : (
                      <Play size={15} />
                    )}{' '}
                    {actions.activationLabel}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!canStop}
                    onClick={() => void actions.stop().catch(() => {})}
                  >
                    <Square size={14} /> Stop
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!desktop || busy}
                    onClick={() =>
                      void runtime.refresh().catch((e) => runtime.setError(errorText(e)))
                    }
                  >
                    <RefreshCw size={14} /> Refresh
                  </button>
                </div>
                <p className="runtime-scope">Applying changes may interrupt connections.</p>
                {issues.length > 0 && (
                  <section className="runtime-section runtime-diagnostics">
                    <h3>Graph problems and hints</h3>
                    <DiagnosticList issues={issues} onIssue={onIssue} />
                  </section>
                )}
                {onSystemCapture && (
                  <div className="action-row runtime-actions">
                    <button className="secondary-button" onClick={onSystemCapture} disabled={busy}>
                      <ShieldCheck size={16} /> System traffic capture…
                    </button>
                  </div>
                )}
                <p className="runtime-scope">
                  Closing Wayrill leaves networking active. Stop restores owned proxy settings if
                  they still match; external changes are preserved.
                </p>
              </>
            ) : (
              <>
                <div className="action-row runtime-actions">
                  <p className="runtime-scope">Core diagnostics may contain endpoint details.</p>
                  <button className="secondary-button" onClick={runtime.clearEvents}>
                    Clear view
                  </button>
                </div>
                <div className="runtime-events" aria-label="Service events">
                  {events.length ? (
                    events.map((event, index) => (
                      <div key={`${event.sequence}-${index}`}>
                        <time>{new Date(event.timestampMs).toLocaleTimeString()}</time>
                        <strong>{event.kind}</strong>
                        <span>
                          {event.kind === 'core.log' &&
                          event.payload &&
                          typeof event.payload === 'object' &&
                          'message' in event.payload
                            ? String(event.payload.message)
                            : JSON.stringify(event.payload)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p>No events received yet.</p>
                  )}
                </div>
              </>
            )}
          </EditorTabPanels>
        </RuntimeProgressOverlay>
        <div className="rule-editor-footer">
          <span role="status">{busy ? 'Waiting for service…' : ''}</span>
          <button className="secondary-button" onClick={onClose}>
            Close
          </button>
        </div>
      </dialog>
      {checkOpen && (
        <GraphCheckDialog actions={actions} onClose={() => setCheckOpen(false)} onIssue={onIssue} />
      )}
    </>
  );
}

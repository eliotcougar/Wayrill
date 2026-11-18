import type { RuntimeState } from './runtimeSession';
import type { RuntimeCompilation } from './graph/runtime';
import { matchesApplied, matchesCapture } from './runtimeState';

type RuntimeViewState = Pick<
  RuntimeState,
  'connected' | 'snapshot' | 'savedConfig' | 'savedCapture' | 'savedRevision' | 'savedDisplayNames'
> & { desktop: boolean; capabilities?: string[] };

// The applied profile includes the capture sidecar. A cached snapshot is useful
// history, but cannot establish what is running while the service is offline.
export function runtimePresentation(
  runtime: RuntimeViewState,
  draft: RuntimeCompilation | null,
  poolDocumentMatches?: boolean,
  syncingPool = false,
) {
  const { snapshot, desktop } = runtime;
  const current = desktop && runtime.connected && !!snapshot;
  const profileCurrent = current && runtime.savedRevision === snapshot.config.revision;
  const resourcesChanged = current && !!snapshot.resources?.restartRequired;
  const appliedMatch =
    profileCurrent &&
    !syncingPool &&
    snapshot.config.present &&
    (poolDocumentMatches ??
      (matchesApplied(draft?.config ?? null, runtime.savedConfig, !!draft?.resolverActivity) &&
        matchesCapture(draft?.capture, runtime.savedCapture) &&
        (!runtime.capabilities?.includes('xray.routingLog') ||
          (matchesCapture(draft?.displayNames?.routing, runtime.savedDisplayNames?.routing) &&
            matchesCapture(
              draft?.displayNames?.routingDefault,
              runtime.savedDisplayNames?.routingDefault,
            )))));
  const unavailable = desktop ? 'Service offline' : 'Desktop app required';
  const core = {
    value: current ? snapshot.core.state : 'Unknown',
    detail: current
      ? `v${snapshot.core.version}${snapshot.core.pid ? ` · PID ${snapshot.core.pid}` : ''}`
      : desktop && snapshot
        ? `Service offline · last known: ${snapshot.core.state}`
        : unavailable,
  };
  function comparison(): [string, string] {
    if (!current) return ['Offline', 'Draft comparison unavailable'];
    if (syncingPool) return ['Syncing Pool graph…', 'Loading the applied Pool graph…'];
    if (!snapshot.config.present) return ['Draft not applied', 'Draft has not been applied'];
    if (!profileCurrent) return ['Comparing draft…', 'Refreshing draft comparison'];
    if (poolDocumentMatches)
      return [
        'Pool graph up to date',
        `Showing the applied Pool graph · revision ${snapshot.config.revision}`,
      ];
    if (!draft) return ['Graph errors', 'Fix graph errors to compare the draft'];
    if (poolDocumentMatches === false)
      return [
        'Unapplied local edits',
        'Local edits are pending. Routing uses the applied Pool graph.',
      ];
    return appliedMatch
      ? ['Draft matches', `Draft matches applied revision ${snapshot.config.revision}`]
      : ['Draft changed', 'Draft has unapplied changes'];
  }
  const [shortState, draftState] = comparison();
  const resourceState = !resourcesChanged
    ? ''
    : snapshot.resources?.reloadPending
      ? 'Resource reload pending'
      : 'Resource reload required';
  const applied = {
    value: current
      ? snapshot.config.present
        ? `Revision ${snapshot.config.revision}`
        : 'Not applied'
      : 'Unknown',
    detail:
      !current && desktop && snapshot?.config.present
        ? `Last known: revision ${snapshot.config.revision} · comparison unavailable`
        : [draftState, resourceState].filter(Boolean).join(' · '),
  };
  const proxy = {
    value: !current
      ? 'Unknown'
      : snapshot.systemProxy.conflict
        ? 'External change'
        : snapshot.systemProxy.recoveryPending
          ? 'Recovery pending'
          : snapshot.systemProxy.managed
            ? 'Managed by Wayrill'
            : 'Not managed',
    detail: !current
      ? unavailable
      : snapshot.systemProxy.conflict
        ? 'External settings are preserved; review ownership below'
        : snapshot.systemProxy.recoveryPending
          ? 'Restoration needs attention; review ownership below'
          : 'User proxy settings · apps may bypass this proxy',
  };
  const capture = {
    value: current ? (snapshot.capture?.state ?? 'Not active') : 'Unknown',
    detail: !current
      ? unavailable
      : `${snapshot.capture?.state === 'running' ? snapshot.capture.inputs.length : 0} active inputs · ${profileCurrent ? `${runtime.savedCapture?.inputs.filter((i) => i.source !== 'tun').length ?? 0} applied inputs` : 'applied scope refreshing'}`,
  };
  const footer = !desktop
    ? 'Draft only · browser session'
    : !current
      ? 'Runtime unknown · service offline'
      : `Xray ${core.value}${snapshot.config.present ? ` · r${snapshot.config.revision}` : ''} · ${shortState}${resourceState ? ` · ${resourceState}` : ''}`;
  return {
    current,
    profileCurrent,
    running: current && snapshot.core.state === 'running',
    appliedMatch,
    core,
    applied,
    proxy,
    capture,
    draftState,
    footer,
    description: `${footer}. Windows proxy: ${proxy.value}. WinDivert capture: ${capture.value}. ${capture.detail}. Core state does not establish traffic flow.`,
  };
}

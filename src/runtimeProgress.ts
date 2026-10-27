export type RuntimeOperation = 'start' | 'restart' | 'reloadResources' | 'apply' | 'stop';
export type RuntimeStage =
  | 'preflight'
  | 'protectApps'
  | 'resolve'
  | 'validate'
  | 'checkpoint'
  | 'retireTun'
  | 'retireSharing'
  | 'startSharing'
  | 'updateRules'
  | 'renameAdapters'
  | 'drainCapture'
  | 'saveCounters'
  | 'restoreSettings'
  | 'stopCore'
  | 'saveProfile'
  | 'prepare'
  | 'startCore'
  | 'waitCore'
  | 'startTun'
  | 'startCapture'
  | 'applySettings'
  | 'commit';
export interface NativeActivity {
  phase:
    | 'checkSharing'
    | 'enablePublic'
    | 'enablePrivate'
    | 'disableSharing'
    | 'restoreServices'
    | 'waitAdapter'
    | 'verifySharing';
  elapsedMs: number;
}
export interface RuntimeProgress {
  operation: RuntimeOperation;
  stage: RuntimeStage;
  percent: number | null;
  recovering: boolean;
}
export function runtimeOperation(method: string): RuntimeOperation | undefined {
  return (
    {
      'core.start': 'start',
      'core.restart': 'restart',
      'config.applyAndStart': 'apply',
      'config.refreshOutbounds': 'apply',
      'core.stop': 'stop',
    } as const
  )[method as 'core.start'];
}
const titles: Record<RuntimeOperation, string> = {
  start: 'Starting networking',
  restart: 'Restarting networking',
  reloadResources: 'Refreshing resource filters',
  apply: 'Applying graph',
  stop: 'Stopping networking',
};
const stages: Record<RuntimeStage, string> = {
  preflight: 'Checking configuration',
  protectApps: 'Protecting selected applications',
  resolve: 'Resolving outbound addresses',
  validate: 'Validating configuration',
  checkpoint: 'Saving recovery checkpoint',
  retireTun: 'Stopping TUN capture',
  retireSharing: 'Stopping sharing capture',
  startSharing: 'Configuring Internet sharing',
  updateRules: 'Updating routing rules',
  renameAdapters: 'Renaming TUN adapters',
  drainCapture: 'Draining packet capture',
  saveCounters: 'Saving traffic counters',
  restoreSettings: 'Restoring Windows settings',
  stopCore: 'Stopping Xray',
  saveProfile: 'Saving configuration',
  prepare: 'Preparing runtime configuration',
  startCore: 'Starting Xray',
  waitCore: 'Waiting for Xray',
  startTun: 'Configuring TUN capture',
  startCapture: 'Starting packet capture',
  applySettings: 'Applying Windows settings',
  commit: 'Finishing activation',
};
const nativeStages: Record<NativeActivity['phase'], string> = {
  checkSharing: 'Checking Windows network state',
  enablePublic: 'Windows is enabling public sharing',
  enablePrivate: 'Windows is enabling private sharing',
  disableSharing: 'Windows is disabling sharing',
  restoreServices: 'Restoring shared gateway services',
  waitAdapter: 'Waiting for shared adapter IP and DHCP',
  verifySharing: 'Verifying Windows sharing state',
};
export function runtimeProgress(runtime: {
  connected: boolean;
  snapshot: {
    lifecycle?: RuntimeProgress | null;
    core: { state: string };
  } | null;
  nativeActivity?: NativeActivity;
  pendingOperation?: RuntimeOperation;
  commandStage?: 'resources' | 'request' | 'refresh';
}) {
  const active = runtime.connected ? runtime.snapshot?.lifecycle : null;
  const activity = runtime.connected ? runtime.nativeActivity : undefined;
  const nativeStage =
    activity && nativeStages[activity.phase] && Number.isFinite(activity.elapsedMs)
      ? nativeStages[activity.phase]
      : undefined;
  const elapsed =
    nativeStage && activity
      ? { elapsedSeconds: Math.max(0, Math.floor(activity.elapsedMs / 1000)) }
      : {};
  if (active)
    return {
      title: active.recovering ? 'Restoring previous configuration' : titles[active.operation],
      stage: nativeStage ?? stages[active.stage] ?? 'Waiting for service',
      ...elapsed,
      percent:
        nativeStage || active.percent === null || !Number.isFinite(active.percent)
          ? null
          : Math.max(0, Math.min(100, active.percent)),
    };
  if (runtime.pendingOperation)
    return {
      title: titles[runtime.pendingOperation],
      ...elapsed,
      stage:
        nativeStage ??
        (!runtime.connected
          ? 'Waiting for service'
          : runtime.commandStage === 'resources'
            ? 'Preparing resource files'
            : runtime.commandStage === 'refresh'
              ? 'Refreshing runtime state'
              : 'Waiting for service'),
      percent: null,
    };
  // Older services expose only the Xray transition. Never use cached offline state.
  if (
    runtime.connected &&
    runtime.snapshot &&
    !('lifecycle' in runtime.snapshot) &&
    ['starting', 'stopping'].includes(runtime.snapshot.core.state)
  )
    return {
      title: titles[runtime.snapshot.core.state === 'starting' ? 'start' : 'stop'],
      stage: 'Waiting for service',
      percent: null,
    };
  return null;
}

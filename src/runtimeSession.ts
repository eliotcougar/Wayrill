import type { SubscriptionStatus } from './profiles/serviceSubscriptions';
import { runtimeOperation, type RuntimeOperation, type NativeActivity } from './runtimeProgress';
import { mutationOutcomeUnknown } from './serviceClient';
import { resourceDependencies } from './graph/resources';
import type { CapturePlan } from './graph/capture';
import type { DisplayNames } from './graph/displayNames';
import {
  errorText,
  type ServiceEvent,
  type ServiceMessage,
  type ServiceSnapshot,
  type TransportState,
} from './serviceClient';

export interface ServiceProtocols {
  inbound: string[];
  outbound: string[];
  adapterRuntime: boolean;
}
interface Hello {
  instanceId: string;
  capabilities: string[];
  protocols?: ServiceProtocols;
  maxConfigBytes?: number;
  maxOutbounds?: number;
  maxRoutingRules?: number;
}
export interface ServiceView {
  snapshot: ServiceSnapshot;
  subscriptions: SubscriptionStatus;
  profile: {
    revision: number;
    config: Record<string, unknown> | null;
    capture?: CapturePlan | null;
    displayNames?: DisplayNames;
  };
  hello: Hello;
  sequence: number;
}
export type ServiceRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
export interface RuntimeState {
  snapshot: ServiceSnapshot | null;
  subscriptions: SubscriptionStatus | null;
  savedConfig: Record<string, unknown> | null;
  savedCapture: CapturePlan | null;
  savedRevision: number;
  savedDisplayNames?: DisplayNames;
  connected: boolean;
  busy: boolean;
  pendingOperation?: RuntimeOperation;
  nativeActivity?: NativeActivity;
  commandStage?: 'resources' | 'request' | 'refresh';
  error: string;
  errorAction?: string;
  notice: string;
  events: ServiceEvent[];
  capabilities: string[];
  protocols: ServiceProtocols | null;
  limits: { configBytes: number; outbounds: number; routingRules: number } | null;
}

function commandNotice(method: string, snapshot: ServiceSnapshot | null): string {
  if (method === 'config.validate')
    return 'The submitted configuration passed Xray validation. The running configuration was not changed.';
  if (!snapshot) return 'Command completed. Refresh to check the current runtime state.';
  if (method === 'config.refreshOutbounds') return 'Running outbounds updated.';
  if (method === 'config.applyAndStart')
    return `Apply completed. Service reported revision ${snapshot.config.revision}; Xray: ${snapshot.core.state}${snapshot.capture ? `; WinDivert capture: ${snapshot.capture.state}` : ''}.`;
  if (method === 'core.start' || method === 'core.restart')
    return `${method === 'core.start' ? 'Start' : 'Restart'} completed. Service reported revision ${snapshot.config.revision}; Xray: ${snapshot.core.state}.`;
  if (method === 'core.stop') {
    const proxy = snapshot.systemProxy;
    return `Stop completed. Xray: ${snapshot.core.state}. ${
      proxy.conflict
        ? 'External Windows proxy settings were preserved; review ownership.'
        : proxy.recoveryPending || proxy.managed || snapshot.systemCapture?.managed
          ? 'Windows proxy restoration needs attention; review ownership.'
          : 'Wayrill no longer owns Windows proxy settings.'
    }`;
  }
  return '';
}

// Command replies and subscription events arrive independently. An event snapshot
// must never be replaced by an older status request that was already in flight.
export class RuntimeSession {
  private state: RuntimeState = {
    snapshot: null,
    subscriptions: null,
    savedConfig: null,
    savedRevision: -1,
    savedCapture: null,
    connected: false,
    busy: false,
    error: '',
    notice: '',
    events: [],
    capabilities: [],
    protocols: null,
    limits: null,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private cursor = { instanceId: '', sequence: 0 };
  private fetching: Promise<void> | null = null;
  private refreshRequested = false;

  constructor(private request: ServiceRequest) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update = (patch: Partial<RuntimeState>) => {
    this.state = {
      ...this.state,
      ...('error' in patch ? { errorAction: undefined } : {}),
      ...patch,
    };
    for (const listener of this.listeners) listener();
  };

  transport = (state: TransportState) => {
    this.update({
      connected: state.connected,
      ...(!state.connected ? { nativeActivity: undefined } : {}),
      ...(state.connected ? { error: '' } : state.error ? { error: errorText(state.error) } : {}),
    });
  };

  message = (message: ServiceMessage) => {
    if (message.type === 'response') {
      if (!message.ok || !message.result.snapshot) return;
      const snapshot = message.result.snapshot,
        sequence = message.result.sequence ?? 0;
      if (snapshot.instanceId === this.cursor.instanceId && sequence < this.cursor.sequence) return;
      this.cursor = { instanceId: snapshot.instanceId, sequence };
      this.epoch++;
      this.update({
        snapshot,
        subscriptions: message.result.subscriptions ?? null,
        nativeActivity: undefined,
        ...(message.result.replayGap
          ? { notice: 'Service state was refreshed after reconnection.' }
          : {}),
      });
      void this.refresh().catch(() => {});
      return;
    }
    // Replay belongs to the acknowledged instance. Keep old log messages, but
    // reject their state snapshots and stale frames from an earlier connection.
    if (this.cursor.instanceId && message.instanceId !== this.cursor.instanceId) return;
    this.update({ events: [...this.state.events, message].slice(-150) });
    if (message.sequence <= this.cursor.sequence || message.kind === 'core.log') return;
    this.cursor = { instanceId: message.instanceId, sequence: message.sequence };
    if (message.kind === 'subscriptions.changed' || message.kind === 'subscriptions.progress') {
      this.epoch++;
      this.update({ subscriptions: message.payload as SubscriptionStatus });
      return;
    }
    if (message.kind === 'runtime.activity') {
      this.update({ nativeActivity: message.payload as NativeActivity });
      return;
    }
    if (message.payload && typeof message.payload === 'object' && 'core' in message.payload) {
      const snapshot = message.payload as ServiceSnapshot;
      this.epoch++;
      this.update({ snapshot, nativeActivity: undefined });
      if (snapshot.config.revision !== this.state.savedRevision)
        void this.refresh().catch(() => {});
    }
  };

  refresh = (): Promise<void> => {
    this.refreshRequested = true;
    if (this.fetching) return this.fetching;
    let requestEpoch = this.epoch;
    const task = (async () => {
      while (this.refreshRequested) {
        this.refreshRequested = false;
        requestEpoch = this.epoch;
        const view = await this.request<ServiceView>('service.sync');
        const { snapshot, profile, hello, subscriptions, sequence } = view;
        const newer =
          snapshot.instanceId === this.cursor.instanceId && sequence < this.cursor.sequence;
        const current = this.state.snapshot;
        if (
          (requestEpoch !== this.epoch && current?.instanceId !== snapshot.instanceId) ||
          (newer &&
            (profile.revision !== current?.config.revision ||
              snapshot.config.sha256 !== current.config.sha256))
        ) {
          this.refreshRequested = true;
          continue;
        }
        // Progress can arrive faster than a large profile reply is decoded. A
        // matching profile is still valid; keep newer live state instead of
        // requesting the same full document indefinitely.
        if (!newer) this.cursor = { instanceId: snapshot.instanceId, sequence };
        this.update({
          ...(!newer ? { snapshot, subscriptions } : {}),
          savedConfig: profile.config,
          savedCapture: profile.capture ?? null,
          savedDisplayNames: profile.displayNames ?? undefined,
          savedRevision: profile.revision,
          capabilities: hello.capabilities,
          protocols: hello.protocols ?? null,
          limits:
            typeof hello.maxConfigBytes === 'number' &&
            typeof hello.maxOutbounds === 'number' &&
            typeof hello.maxRoutingRules === 'number'
              ? {
                  configBytes: hello.maxConfigBytes,
                  outbounds: hello.maxOutbounds,
                  routingRules: hello.maxRoutingRules,
                }
              : null,
          connected: true,
        });
      }
    })().catch((error) => {
      this.update({
        connected: requestEpoch !== this.epoch && this.state.connected,
        error: errorText(error),
      });
      throw error;
    });
    this.fetching = task;
    void task
      .finally(() => {
        this.fetching = null;
      })
      .catch(() => {});
    return task;
  };

  run = async (
    method: string,
    params: Record<string, unknown> = {},
    prepare?: () => Promise<Record<string, unknown>>,
  ) => {
    if (this.state.busy) throw new Error('Wait for the current service operation to finish.');
    this.update({
      busy: true,
      pendingOperation: runtimeOperation(method),
      commandStage: 'request',
      error: '',
      notice: '',
    });
    let acknowledged = false;
    let dispatched = false;
    try {
      let payload = params;
      if (params.resources && params.config) {
        const { resources, ...rest } = params;
        const required = resourceDependencies(params.config);
        if (required.length) {
          this.update({ commandStage: 'resources' });
          const deadline = Date.now() + 300_000;
          for (;;) {
            const prepared = await this.request<{ ready: boolean; busy: boolean }>(
              'resources.ensure',
              { files: resources, required },
            );
            if (prepared.ready && !prepared.busy) break;
            if (!prepared.busy || Date.now() > deadline)
              throw new Error('Resource files are not ready. Review Settings → Resource files.');
            this.update({ notice: 'Preparing resource files…' });
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        payload = rest;
      }
      this.update({ commandStage: 'request' });
      if (prepare) payload = { ...payload, ...(await prepare()) };
      dispatched = true;
      const result = await this.request<unknown>(method, payload);
      acknowledged = true;
      this.update({ commandStage: 'refresh' });
      await this.refresh();
      this.update({ notice: commandNotice(method, this.state.snapshot) });
      return result;
    } catch (error) {
      if (!acknowledged) {
        try {
          await this.refresh();
        } catch {
          /* Keep the command failure alongside offline state. */
        }
      }
      this.update({
        errorAction: method,
        error: acknowledged
          ? `The command completed, but runtime status could not be refreshed: ${errorText(error)}`
          : dispatched && method !== 'config.validate' && mutationOutcomeUnknown(error)
            ? `The command outcome is unknown. Check the current runtime state before retrying. ${errorText(error)}`
            : errorText(error),
      });
      throw error;
    } finally {
      this.update({
        busy: false,
        pendingOperation: undefined,
        commandStage: undefined,
        nativeActivity: undefined,
      });
    }
  };
}

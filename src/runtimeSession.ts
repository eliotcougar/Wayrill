import type { SubscriptionStatus } from './profiles/serviceSubscriptions';
import {
  canSupersedeRoutingCommand,
  runtimeOperation,
  type CommandStage,
  type RuntimeOperation,
  type NativeActivity,
} from './runtimeProgress';
import { mutationOutcomeUnknown } from './serviceClient';
import { interruptible, waitForTestJob } from './outboundTestJobs';
import { resourceDependencies } from './graph/resources';
import { jsonEqual, jsonRecord } from './graph/xrayJson';
import type { CapturePlan } from './graph/capture';
import type { DisplayNames } from './graph/displayNames';
import {
  errorText,
  type ResourceScheduleVersion,
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
  commandStage?: CommandStage;
  error: string;
  errorAction?: string;
  notice: string;
  capabilities: string[];
  protocols: ServiceProtocols | null;
  limits: { configBytes: number; outbounds: number; routingRules: number } | null;
}

type RoutingReceipt =
  | { state: 'pending' | 'succeeded' | 'notSubmitted' | 'unavailable' }
  | { state: 'failed'; error: import('./serviceClient').ServiceError };

export const routingCommandSuperseded = Symbol();

function commandOutcomeError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
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

const syncRetryDelays = [250, 500, 1000, 2000, 4000];

function isServiceBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'BUSY';
}

function isRuntimeSnapshot(value: unknown, instanceId: string): value is ServiceSnapshot {
  // An upgrade receipt also has a core field. It belongs in Events, not runtime state.
  return (
    jsonRecord(value) &&
    value.instanceId === instanceId &&
    jsonRecord(value.config) &&
    typeof value.config.revision === 'number' &&
    jsonRecord(value.core) &&
    typeof value.core.state === 'string'
  );
}

function editorStatus(snapshot: ServiceSnapshot | null) {
  return (
    snapshot && {
      ...snapshot,
      uptimeSeconds: undefined,
      traffic: undefined,
      observation: undefined,
      fakeDns: undefined,
      winDivert: { ...snapshot.winDivert, packets: undefined, bytes: undefined },
      capture: snapshot.capture && { ...snapshot.capture, packets: undefined, bytes: undefined },
    }
  );
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
    capabilities: [],
    protocols: null,
    limits: null,
  };
  private listeners = new Set<() => void>();
  private editorState = this.state;
  private editorStatus = editorStatus(this.state.snapshot);
  private events: ServiceEvent[] = [];
  private eventListeners = new Set<() => void>();
  private epoch = 0;
  private transportEpoch = 0;
  private cursor = { instanceId: '', sequence: 0 };
  private fetching: Promise<void> | null = null;
  private refreshRequested = false;
  private command = 0;
  private receiptWait?: AbortController;

  constructor(private request: ServiceRequest) {}

  getSnapshot = () => this.state;
  getLiveSnapshot = () => this.state.snapshot;
  getEditorState = () => this.editorState;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getEvents = () => this.events;
  subscribeEvents = (listener: () => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };
  clearEvents = () => {
    if (this.events.length) this.updateEvents([]);
  };
  private updateEvents(events: ServiceEvent[]) {
    this.events = events;
    for (const listener of this.eventListeners) listener();
  }
  update = (patch: Partial<RuntimeState>) => {
    const before = this.state;
    this.state = {
      ...this.state,
      ...('error' in patch ? { errorAction: undefined } : {}),
      ...patch,
    };
    // Polling snapshots also carry real lifecycle and ownership transitions.
    // Compare those fields by value, and leave rate/probe consumers on the live store.
    const { snapshot } = this.state;
    if (snapshot !== before.snapshot) {
      const status = editorStatus(snapshot);
      if (!jsonEqual(this.editorStatus, status)) {
        this.editorStatus = status;
        this.editorState = this.state;
      }
    }
    if (
      before.errorAction !== this.state.errorAction ||
      Object.keys(patch).some((key) => {
        const field = key as keyof RuntimeState;
        return field !== 'snapshot' && this.state[field] !== before[field];
      })
    )
      this.editorState = this.state;
    for (const listener of this.listeners) listener();
  };

  transport = (state: TransportState) => {
    this.transportEpoch++;
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
    // Periodic snapshots drive the live view, not diagnostic history. Replayed
    // events keep their original identity and should appear only once.
    if (
      message.kind !== 'service.snapshot' &&
      !this.events.some(
        (event) => event.instanceId === message.instanceId && event.sequence === message.sequence,
      )
    )
      this.updateEvents([...this.events, message].slice(-150));
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
    if (isRuntimeSnapshot(message.payload, message.instanceId)) {
      const snapshot = message.payload;
      this.epoch++;
      this.update({ snapshot, nativeActivity: undefined });
      if (snapshot.config.revision !== this.state.savedRevision)
        void this.refresh().catch(() => {});
    }
  };

  private async readView(transportEpoch: number): Promise<ServiceView | undefined> {
    let retries = 0;
    while (transportEpoch === this.transportEpoch) {
      try {
        return await this.request<ServiceView>('service.sync');
      } catch (error) {
        const delay = syncRetryDelays[retries++];
        if (!isServiceBusy(error) || delay === undefined) throw error;
        if (transportEpoch !== this.transportEpoch) return;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  refresh = (): Promise<void> => {
    this.refreshRequested = true;
    if (this.fetching) return this.fetching;
    let requestEpoch = this.epoch;
    const task = (async () => {
      while (this.refreshRequested) {
        this.refreshRequested = false;
        requestEpoch = this.epoch;
        const transportEpoch = this.transportEpoch;
        let view: ServiceView | undefined;
        try {
          view = await this.readView(transportEpoch);
        } catch (error) {
          // A reconnect/manual refresh queued behind this request still needs
          // its turn, but repeated snapshots must not reset the busy retry budget.
          if (
            this.refreshRequested &&
            (!isServiceBusy(error) || transportEpoch !== this.transportEpoch)
          )
            continue;
          throw error;
        }
        if (!view || transportEpoch !== this.transportEpoch) {
          if (this.state.connected || this.refreshRequested) {
            this.refreshRequested = true;
            continue;
          }
          throw Object.assign(new Error('Service disconnected during synchronization.'), {
            code: 'DISCONNECTED',
          });
        }
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
        connected: this.state.connected && (isServiceBusy(error) || requestEpoch !== this.epoch),
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

  private async reconcile(ticket: string, instanceId: string, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      if (this.state.connected && this.state.snapshot?.instanceId !== instanceId)
        throw commandOutcomeError(
          'COMMAND_OUTCOME_UNAVAILABLE',
          'The service restarted before the command outcome could be confirmed. Review the current routing state.',
        );
      let receipt: RoutingReceipt | undefined;
      try {
        receipt = await interruptible(signal, () =>
          this.request<RoutingReceipt>('service.operationGet', { ticket }),
        );
      } catch (error) {
        signal.throwIfAborted();
        if (jsonRecord(error) && error.code === 'METHOD_NOT_FOUND')
          throw commandOutcomeError(
            'COMMAND_OUTCOME_UNAVAILABLE',
            'The command outcome is unavailable. Review the current routing state.',
          );
        if (
          !mutationOutcomeUnknown(error) &&
          !isServiceBusy(error) &&
          !(jsonRecord(error) && error.code === 'SERVICE_STOPPING')
        )
          throw error;
      }
      switch (receipt?.state) {
        case 'succeeded':
          return;
        case 'failed':
          throw Object.assign(new Error(receipt.error.message), receipt.error);
        case 'notSubmitted':
          throw commandOutcomeError(
            'COMMAND_NOT_SUBMITTED',
            'The routing command did not reach the service. You can try it again.',
          );
        case 'unavailable':
          throw commandOutcomeError(
            'COMMAND_OUTCOME_UNAVAILABLE',
            'The command outcome is unavailable. Review the current routing state.',
          );
        default:
          await waitForTestJob(receipt ? 250 : 1000, signal);
      }
    }
  }

  run = async (
    method: string,
    params: Record<string, unknown> = {},
    prepare?: () => Promise<Record<string, unknown>>,
  ) => {
    if (
      this.state.busy &&
      !(
        method === 'core.stop' &&
        canSupersedeRoutingCommand(this.state.pendingOperation, this.state.commandStage)
      )
    )
      throw new Error('Wait for the current service operation to finish.');
    this.receiptWait?.abort();
    this.receiptWait = undefined;
    const command = ++this.command;
    const current = () => this.command === command;
    const operation = runtimeOperation(method);
    this.update({
      busy: true,
      pendingOperation: operation,
      commandStage: operation && operation !== 'stop' ? 'prepare' : 'request',
      error: '',
      notice: '',
    });
    let acknowledged = false;
    let dispatched = false;
    const instanceId = this.state.snapshot?.instanceId;
    const tracked =
      !!instanceId && !!operation && this.state.capabilities.includes('routing.commandReceipts');
    let ticket: string | undefined;
    try {
      // Register the intent before any preflight can block on a slow download or
      // graph transfer. A Stop from the tray can revoke this same ticket.
      if (tracked) {
        ticket = (
          await this.request<{ ticket: string }>('service.operationPrepare', {
            method,
            instanceId,
          })
        ).ticket;
      }
      if (!current()) return routingCommandSuperseded;
      let payload = params;
      if (params.resources && params.config) {
        const { resources, ...rest } = params;
        const required = resourceDependencies(params.config);
        if (required.length) {
          this.update({ commandStage: 'resources' });
          const deadline = Date.now() + 300_000;
          const base = await this.request<ResourceScheduleVersion>('resources.scheduleVersion');
          for (;;) {
            if (!current()) return routingCommandSuperseded;
            const prepared = await this.request<{ ready: boolean; busy: boolean }>(
              'resources.ensure',
              { files: resources, required, base, ...(ticket ? { routingTicket: ticket } : {}) },
            );
            if (!current()) return routingCommandSuperseded;
            if (prepared.ready && !prepared.busy) break;
            if (!prepared.busy || Date.now() > deadline)
              throw new Error('Resource files are not ready. Review Settings → Resource files.');
            this.update({ notice: 'Preparing resource files…' });
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        payload = rest;
      }
      if (operation && operation !== 'stop') this.update({ commandStage: 'prepare' });
      if (prepare) payload = { ...payload, ...(await prepare()) };
      if (!current()) return routingCommandSuperseded;
      this.update({ commandStage: 'request' });
      dispatched = true;
      let result: unknown;
      try {
        result = await this.request<unknown>(method, ticket ? { ...payload, ticket } : payload);
      } catch (error) {
        if (!current()) return routingCommandSuperseded;
        if (!ticket || !instanceId || !mutationOutcomeUnknown(error)) throw error;
        const wait = new AbortController();
        this.receiptWait = wait;
        this.update({ commandStage: 'reconcile' });
        try {
          await this.reconcile(ticket, instanceId, wait.signal);
        } finally {
          if (this.receiptWait === wait) this.receiptWait = undefined;
        }
      }
      if (this.command !== command) return routingCommandSuperseded;
      acknowledged = true;
      this.update({ commandStage: 'refresh' });
      await this.refresh();
      if (!current()) return routingCommandSuperseded;
      this.update({ notice: commandNotice(method, this.state.snapshot) });
      return result;
    } catch (error) {
      if (this.command !== command) return routingCommandSuperseded;
      if (!acknowledged) {
        try {
          await this.refresh();
        } catch {
          /* Keep the command failure alongside offline state. */
        }
      }
      if (!current()) return routingCommandSuperseded;
      this.update({
        errorAction: method,
        error: acknowledged
          ? `The command completed, but runtime status could not be refreshed: ${errorText(error)}`
          : dispatched && !tracked && method !== 'config.validate' && mutationOutcomeUnknown(error)
            ? `The command outcome is unknown. Check the current runtime state before retrying. ${errorText(error)}`
            : errorText(error),
      });
      throw error;
    } finally {
      if (ticket && !dispatched) {
        // A failed or superseded preparation cannot leave an unused live ticket.
        void this.request('service.operationGet', { ticket }).catch(() => {});
      }
      if (current())
        this.update({
          busy: false,
          pendingOperation: undefined,
          commandStage: undefined,
          nativeActivity: undefined,
        });
    }
  };
}

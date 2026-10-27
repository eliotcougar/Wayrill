import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TrafficSnapshot } from './traffic';
import type { RuntimeProgress } from './runtimeProgress';
export const desktopServiceAvailable = () => isTauri();
export type ServiceError = {
  code: string;
  message: string;
  retryable: boolean;
};
export type SubscriptionStatus = {
  version: number;
  initialized: boolean;
  error: ServiceError | null;
  busy: boolean;
  automatic: boolean;
  statuses: Record<string, { state: 'refreshing' | 'testing' | 'idle' | 'error'; message: string }>;
  appliedRevision: number | null;
  appliedSourceHash: string | null;
};
export type ResourceWarningReport = {
  skippedSelectorCount: number;
  skippedSelectors: { selector: string; context: string }[];
};
export type ConfigValidationResult = { resourceWarnings?: ResourceWarningReport };
export type ServiceSnapshot = {
  fakeDns?: {
    pid: number | null;
    usage: {
      used: number;
      capacity: number;
      pools: { ipPool: string; used: number; capacity: number }[];
    } | null;
  } | null;
  appProtection?: { blocked: boolean; phase: string; error: ServiceError | null };
  lifecycle?: RuntimeProgress | null;
  recovery?: {
    desiredState: 'running' | 'stopped' | 'unknown';
    state: 'stopped' | 'healthy' | 'waiting' | 'blocked';
    attempts: number;
    nextAttemptMs: number | null;
    lastError: ServiceError | null;
  };
  serviceVersion: string;
  apiVersion: number;
  instanceId: string;
  ownerSid: string;
  uptimeSeconds: number;
  startup?: {
    enabled: boolean;
    runtimeAccount: string;
    lastAttemptMs: number | null;
    lastError: ServiceError | null;
    waitingForNetwork?: boolean;
    attempts?: number;
  };
  config: {
    present: boolean;
    revision: number;
    sha256: string | null;
    recoveryError?: ServiceError | null;
  };
  core: {
    state: string;
    failureSource?: 'core' | 'fakeDns' | 'capture' | 'tun' | 'network' | null;
    pid: number | null;
    userSid?: string | null;
    generation: number;
    version: string;
    lastError: ServiceError | null;
  };
  network?: {
    state: 'inactive' | 'ready' | 'waiting' | 'settling' | 'reconnecting';
    lastError: ServiceError | null;
    uplinks: { id: string; name: string; interfaceIndex: number }[];
  };
  tunAdapters?: { reuseAdapters: boolean };
  tun?: {
    state: string;
    pid: number | null;
    name: string | null;
    interfaceIndex: number | null;
    uplink: string | null;
    adapterRecoveryError?: ServiceError | null;
    sharedPid?: number | null;
    sharedName?: string | null;
    sharing?: {
      managed: boolean;
      recoveryPending: boolean;
      lastError: ServiceError | null;
      upstream: string | null;
      private: string | null;
    };
  };
  winDivert: {
    available: boolean;
    mode: string;
    state: string;
    packets: number;
    bytes: number;
    port?: number;
    lastError?: number;
  };
  capture?: {
    state: string;
    mode: string;
    inputs: string[];
    lastError?: string | null;
    packets?: number;
    bytes?: number;
    firewallManaged?: boolean;
    firewallRecoveryError?: string | null;
    availability?: {
      state: 'available' | 'blocked' | 'unknown';
      message: string | null;
    };
  };
  systemProxy: {
    managed: boolean;
    conflict: boolean;
    recoveryPending: boolean;
  };
  userSettings?: { waitingForUser: boolean; lastError: ServiceError | null };
  systemCapture?: { managed: boolean; channels: string[]; error?: string };
  resources?: {
    busy: boolean;
    generation: number;
    restartRequired: boolean;
    reloadPending?: boolean;
    reloadError?: ServiceError | null;
    skippedSelectorCount?: number;
    skippedSelectors?: ResourceWarningReport['skippedSelectors'];
  };
  traffic?: TrafficSnapshot;
  observation?: {
    generation: number;
    revision: number;
    sampledAtMs: number;
    truncated: boolean;
    outbounds?: { tag: string; checked: boolean; alive: boolean; latencyMs: number | null }[];
    groups: {
      tag: string;
      strategy: string;
      total: number;
      checked: number;
      alive: number;
      latencyMs: number | null;
    }[];
  } | null;
};
export type ServiceEvent = {
  type: 'event';
  apiVersion: number;
  instanceId: string;
  sequence: number;
  timestampMs: number;
  kind: string;
  payload: unknown;
};
export type ServiceMessage =
  | ServiceEvent
  | {
      type: 'response';
      ok: boolean;
      result: {
        instanceId?: string;
        sequence?: number;
        snapshot?: ServiceSnapshot;
        subscriptions?: SubscriptionStatus;
        replayGap?: boolean;
      };
    };
export type TransportState = { connected: boolean; error?: ServiceError };
export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}
export async function serviceCall<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!desktopServiceAvailable())
    throw new Error('Service controls are available in the Windows desktop app.');
  return invoke<T>('service_request', { method, params });
}
export async function serviceEvents(
  onMessage: (message: ServiceMessage) => void,
  onTransport: (state: TransportState) => void,
) {
  const removeMessages = await listen<ServiceMessage>('wayrill-service-event', (event) =>
    onMessage(event.payload),
  );
  let removeTransport: (() => void) | undefined;
  try {
    removeTransport = await listen<TransportState>('wayrill-service-transport', (event) =>
      onTransport(event.payload),
    );
    await invoke('service_events_start');
    return () => {
      removeMessages();
      removeTransport?.();
    };
  } catch (error) {
    removeMessages();
    removeTransport?.();
    throw error;
  }
}
export const localDirectExample = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      tag: 'local-socks',
      listen: '127.0.0.1',
      port: 2080,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: true },
    },
    {
      tag: 'local-http',
      listen: '127.0.0.1',
      port: 2081,
      protocol: 'http',
      settings: {},
    },
  ],
  outbounds: [
    { tag: 'direct', protocol: 'freedom', settings: {} },
    { tag: 'block', protocol: 'blackhole', settings: {} },
  ],
  routing: { domainStrategy: 'AsIs', rules: [] },
};

// Transport failures can occur after a mutation reaches the service. A readonly
// refresh helps establish current state, but cannot prove the command's outcome.
export function mutationOutcomeUnknown(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return true;
  return ['TIMEOUT', 'DISCONNECTED', 'OS_ERROR', 'INVALID_FRAME'].includes(String(error.code));
}

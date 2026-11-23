import { invoke, isTauri } from '@tauri-apps/api/core';
import type { NginxObservation } from './nginxRoutes';

export interface SavedSession {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
}
export interface SessionInventory {
  sessions: SavedSession[];
  executable: string | null;
  executableVersion: string | null;
  compatibilityError: string | null;
  source: string;
  selectedConfig: string;
  configs: string[];
  windowsUser: string;
  warnings: string[];
}
export interface ConfigFile {
  path: string;
  size: number;
  modified: number;
  running: boolean;
  source: string;
  readable: boolean;
  services?: string[];
}
export interface Discovery {
  version: number;
  hostname: string;
  processes: {
    pid: number;
    executable: string;
    configPaths: string[];
    configDirectories: string[];
  }[];
  files: ConfigFile[];
  warnings: string[];
}
export interface WayrillCompanion {
  path: string;
  text?: string;
  sha256: string | null;
  error?: string;
}
export interface ConfigSnapshot {
  companion?: WayrillCompanion;
  nginx?: NginxObservation;
  path: string;
  text: string;
  sha256: string;
  bytes: number;
}
interface DaemonService {
  name: string;
  activeState: string;
  subState: string;
  mainPid: number | null;
  startedAt: string | null;
  unitFileState: string | null;
  needsDaemonReload: boolean;
}
export interface ServerStatus {
  version: number;
  hostname: string;
  checkedAt: number;
  user: string;
  uid: number;
  bootId?: string | null;
  reboot: { required: boolean | null; packages: string[]; error: string | null };
  xray: {
    installedVersion?: string | null;
    binary?: string | null;
    versionError?: string | null;
    processes: { pid: number; executable: string; replacedExecutable: boolean }[];
    services: DaemonService[];
    error: string | null;
  };
  nginxServices?: DaemonService[];
  apt: {
    available: boolean;
    packages: {
      name: string;
      installedVersion: string | null;
      candidateVersion: string;
      source: string;
    }[];
    upgraded: number | null;
    heldBack: number | null;
    indexesUpdatedAt: number | null;
    error: string | null;
  };
}
export type ServerAction =
  | 'refreshApt'
  | 'upgradeAll'
  | 'distUpgrade'
  | 'upgradePackage'
  | 'restartXray'
  | 'restartNginx'
  | 'reboot'
  | 'applyConfig';
export interface ConfigValidationRequest {
  path: string;
  service: string;
  expectedSha256: string;
  configText: string;
  wayrillText?: string;
  expectedWayrillSha256?: string | null;
  stage: boolean;
}
export interface ConfigValidation {
  version: number;
  id: string | null;
  valid: boolean;
  path: string;
  service: string;
  configSha256: string;
  sourceSha256: string;
  coreVersion: string | null;
  checkedAt: number;
  expiresAt: number;
  logs: string[];
  message: string;
}
export interface ActionRequest {
  id: string;
  action: ServerAction;
  package?: string;
  candidateVersion?: string;
  service?: string;
  planId?: string;
}
export interface PackageChange {
  name: string;
  architecture: string;
  installedVersion: string | null;
  candidateVersion: string | null;
}
export interface UpgradePlan {
  version: number;
  id: string;
  hostname: string;
  createdAt: number;
  expiresAt: number;
  installs: PackageChange[];
  upgrades: PackageChange[];
  removals: PackageChange[];
  heldBack: number;
}
export interface ServerJob {
  version: number;
  id: string;
  action: ServerAction;
  state: 'running' | 'succeeded' | 'failed' | 'interrupted';
  stage: string;
  percent: number | null;
  message: string;
  logs: string[];
  createdAt: number;
  updatedAt: number;
  bootId: string;
  errorCode?: string | null;
  configResult?: {
    path: string;
    service: string;
    planId: string;
    backupPath: string;
    originalSha256: string;
    installedSha256: string;
    wayrillSha256?: string;
    rollback: 'not-needed' | 'pending' | 'succeeded' | 'failed';
  } | null;
}
export interface RemoteClient {
  sessions(): Promise<SessionInventory>;
  choose(kind: 'executable' | 'ini'): Promise<SessionInventory | null>;
  setConfig(config: string): Promise<SessionInventory>;
  resetSetup(): Promise<SessionInventory>;
  discover(session: string, signal?: AbortSignal): Promise<Discovery>;
  read(session: string, path: string, signal?: AbortSignal): Promise<ConfigSnapshot>;
  serverStatus(session: string, signal?: AbortSignal): Promise<ServerStatus>;
  previewUpgrade(session: string, signal?: AbortSignal): Promise<UpgradePlan>;
  validateConfig(
    session: string,
    request: ConfigValidationRequest,
    signal?: AbortSignal,
  ): Promise<ConfigValidation>;
  startAction(session: string, request: ActionRequest): Promise<ServerJob>;
  pollAction(session: string, id: string): Promise<ServerJob>;
  disconnect(): Promise<void>;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message;
  return typeof error === 'string' ? error : 'The read could not be completed.';
}

async function sshRequest<T>(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID().replaceAll('-', '');
  const cancel = () => {
    void invoke('ssh_cancel', { requestId }).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await invoke<T>(method, { ...params, requestId });
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export const nativeClient: RemoteClient = {
  sessions: () => invoke<SessionInventory>('ssh_sessions'),
  choose: (kind) => invoke<SessionInventory | null>('ssh_choose_winscp', { kind }),
  setConfig: (config) => invoke<SessionInventory>('ssh_set_config', { config }),
  resetSetup: () => invoke<SessionInventory>('ssh_reset_setup'),
  discover: (session, signal) => sshRequest<Discovery>('ssh_discover', { session }, signal),
  read: (session, path, signal) =>
    sshRequest<ConfigSnapshot>('ssh_read_config', { session, path }, signal),
  serverStatus: (session, signal) =>
    sshRequest<ServerStatus>('ssh_server_status', { session }, signal),
  previewUpgrade: (session, signal) =>
    sshRequest<UpgradePlan>('ssh_preview_upgrade', { session }, signal),
  validateConfig: (session, request, signal) =>
    sshRequest<ConfigValidation>('ssh_validate_config', { session, request }, signal),
  startAction: (session, request) =>
    sshRequest<ServerJob>('ssh_start_action', { session, request }),
  pollAction: (session, id) => sshRequest<ServerJob>('ssh_poll_action', { session, id }),
  disconnect: () => invoke('ssh_disconnect'),
};
export const desktopAvailable = isTauri();

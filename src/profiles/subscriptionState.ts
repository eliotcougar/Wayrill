import type { StashEntry, StashGroup } from './import';

export interface SubscriptionMaintenance {
  autoRefresh: boolean;
  refreshMinutes: number;
  removeUnreachable: boolean;
  maxRetries: number;
  viaProxy: boolean;
}
export interface SubscriptionHealth {
  status: 'alive' | 'dead' | 'unavailable';
  checkedAt: number;
  profileId: string;
  latencyMs: number | null;
}
export interface HealthObservation {
  entryId: string;
  health: SubscriptionHealth;
}
export const maintenanceDefaults: SubscriptionMaintenance = {
  autoRefresh: false,
  refreshMinutes: 360,
  removeUnreachable: false,
  maxRetries: 2,
  viaProxy: false,
};
export function validMaintenance(value: unknown): value is SubscriptionMaintenance {
  if (!value || typeof value !== 'object') return false;
  const v = value as SubscriptionMaintenance;
  return (
    typeof v.autoRefresh === 'boolean' &&
    typeof v.viaProxy === 'boolean' &&
    typeof v.removeUnreachable === 'boolean' &&
    Number.isInteger(v.maxRetries) &&
    v.maxRetries >= 0 &&
    v.maxRetries <= 5 &&
    [v.refreshMinutes].every((n) => Number.isInteger(n) && n >= 1 && n <= 10080)
  );
}
export function validHealth(value: unknown): value is SubscriptionHealth {
  if (!value || typeof value !== 'object') return false;
  const v = value as SubscriptionHealth;
  return (
    ['alive', 'dead', 'unavailable'].includes(v.status) &&
    Number.isSafeInteger(v.checkedAt) &&
    v.checkedAt >= 0 &&
    typeof v.profileId === 'string' &&
    /^[a-f0-9]{32}$/.test(v.profileId) &&
    (v.latencyMs === null || (Number.isFinite(v.latencyMs) && v.latencyMs >= 0))
  );
}
/** Reachability reports never disable a saved configuration. */
export const entryAvailable = (entry: StashEntry) => !!entry.profile;

/** Refresh timing changes do not invalidate completed tests or restart a scan. */
export function setGroupMaintenance(group: StashGroup, value: SubscriptionMaintenance): StashGroup {
  const previous = group.maintenance ?? maintenanceDefaults;
  if (
    (value.removeUnreachable || group.testCycleAt === undefined) &&
    (Object.keys(maintenanceDefaults) as (keyof SubscriptionMaintenance)[]).every(
      (key) => previous[key] === value[key],
    )
  )
    return group;
  const retest =
    value.removeUnreachable &&
    (value.removeUnreachable !== previous.removeUnreachable ||
      value.maxRetries !== previous.maxRetries);
  return {
    ...group,
    maintenance: value,
    ...(retest ? { lastTestAt: undefined } : {}),
    ...(retest || !value.removeUnreachable ? { testCycleAt: undefined } : {}),
  };
}

/** Normalize the immediately preceding saved setting; all writes use the new policy. */
export function normalizeMaintenance(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('testMode' in value)) return value;
  if (!['off', 'disable', 'delete'].includes(String(value.testMode))) return value;
  const settings = { ...value } as Record<string, unknown>;
  settings.removeUnreachable = settings.testMode !== 'off';
  delete settings.testMode;
  delete settings.retestMinutes;
  return settings;
}

import { jsonRecord } from '../graph/xrayJson';
import { THEME_STORAGE_KEY } from '../theme';
import {
  testSettingsKey,
  testUrlProblem,
  udpUrlProblem,
  loadOutboundTestSettings,
} from '../outboundTestSettings';
import { TRAFFIC_UNITS_KEY } from '../trafficUnits';
import { TRAFFIC_SORTING_KEY } from '../trafficSorting';

const keys = [THEME_STORAGE_KEY, testSettingsKey, TRAFFIC_UNITS_KEY, TRAFFIC_SORTING_KEY] as const;
export type Preferences = Partial<Record<(typeof keys)[number], string | null>>;

export function validatePreferences(value: unknown): Preferences {
  if (
    !jsonRecord(value) ||
    Object.keys(value).some((key) => !keys.includes(key as (typeof keys)[number]))
  )
    throw new Error('Invalid application preferences.');
  for (const [key, text] of Object.entries(value)) {
    if (text === null) continue;
    if (typeof text !== 'string' || text.length > 16384)
      throw new Error('Invalid application preference.');
    if (key === THEME_STORAGE_KEY) {
      if (!['light', 'dark', 'system'].includes(text)) throw new Error('Invalid theme preference.');
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Invalid application preference.');
    }
    if (!jsonRecord(parsed)) throw new Error('Invalid application preference.');
    if (
      key === testSettingsKey &&
      (typeof parsed.testUrl !== 'string' ||
        testUrlProblem(parsed.testUrl) ||
        typeof parsed.countryUrl !== 'string' ||
        testUrlProblem(parsed.countryUrl, true) ||
        typeof parsed.speedUrl !== 'string' ||
        testUrlProblem(parsed.speedUrl) ||
        typeof parsed.udpEnabled !== 'boolean' ||
        typeof parsed.udpUrl !== 'string' ||
        udpUrlProblem(parsed.udpUrl))
    )
      throw new Error('Invalid outbound test preferences.');
    if (
      key === TRAFFIC_UNITS_KEY &&
      (!['bits', 'bytes', 'binary'].includes(String(parsed.rate)) ||
        !['bytes', 'binary'].includes(String(parsed.amount)))
    )
      throw new Error('Invalid traffic units.');
    if (key === TRAFFIC_SORTING_KEY)
      for (const scope of ['inbound', 'outbound']) {
        const sort = parsed[scope];
        if (
          !jsonRecord(sort) ||
          ![
            'name',
            'uploadPerSecond',
            'downloadPerSecond',
            'uploadBytes',
            'downloadBytes',
          ].includes(String(sort.column)) ||
          !['asc', 'desc'].includes(String(sort.direction))
        )
          throw new Error('Invalid traffic sorting.');
      }
  }
  return value;
}
export function readPreferences(): Preferences {
  return validatePreferences(
    Object.fromEntries(
      keys.map((key) => [
        key,
        key === testSettingsKey
          ? JSON.stringify(loadOutboundTestSettings())
          : localStorage.getItem(key),
      ]),
    ),
  );
}

/** Prepare local writes before publishing a workspace; notify observers only on commit. */
export function writePreferences(preferences: Preferences) {
  validatePreferences(preferences);
  const changes = Object.entries(preferences).map(([key, value]) => ({
    key,
    value,
    old: localStorage.getItem(key),
  }));
  const put = (key: string, value: string | null) =>
    value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
  const rollback = () => {
    for (const change of changes) put(change.key, change.old);
  };
  try {
    for (const change of changes) put(change.key, change.value);
  } catch {
    rollback();
    throw new Error('Application preferences could not be saved.');
  }
  return {
    rollback,
    commit: () =>
      changes.forEach((change) =>
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: change.key,
            oldValue: change.old,
            newValue: change.value,
          }),
        ),
      ),
  };
}

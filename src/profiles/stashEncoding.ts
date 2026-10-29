import { getDefinition } from '../graph/catalog';
import { jsonArray, jsonRecord } from '../graph/xrayJson';
import type { Profile, StashGroup } from './import';
import type { SettingValue } from '../graph/types';

// File-local templates freeze the exact values being saved. Reading never fills
// omitted fields from a newer core/app's defaults, or changes profile identities.
export function encodeStashGroup(group: StashGroup): string {
  const settingsDefaults = new Map<string, Record<string, SettingValue>>();
  const entries = group.entries.map((entry) => {
    const profile = entry.profile;
    if (!profile || ['policy-group', 'proxy-chain'].includes(profile.kind)) return entry;
    const defaults = settingsDefaults.get(profile.kind) ?? profile.settings;
    settingsDefaults.set(profile.kind, defaults);
    const settings = Object.fromEntries(
      Object.entries(profile.settings).filter(([key, value]) => defaults[key] !== value),
    );
    const omitted = Object.keys(defaults).filter((key) => !Object.hasOwn(profile.settings, key));
    return {
      ...entry,
      profile: { kind: profile.kind, settings, ...(omitted.length ? { omitted } : {}) },
    };
  });
  return JSON.stringify({
    ...group,
    settingsDefaults: Object.fromEntries(settingsDefaults),
    entries,
  });
}

export function decodeStashGroups(groups: unknown[]): void {
  let count = 0,
    expandedBytes = 0;
  const encoder = new TextEncoder();
  for (const group of groups) {
    if (!jsonRecord(group) || !jsonRecord(group.settingsDefaults) || !jsonArray(group.entries))
      throw new Error('Invalid compact Stash group.');
    const defaults = new Map(Object.entries(group.settingsDefaults));
    for (const [kind, value] of defaults) {
      if (
        !getDefinition(kind as Profile['kind']) ||
        !jsonRecord(value) ||
        ['policy-group', 'proxy-chain'].includes(kind) ||
        !Object.values(value).every((v) => ['string', 'boolean', 'number'].includes(typeof v))
      )
        throw new Error('Invalid Stash settings template.');
    }
    for (const entry of group.entries) {
      if (++count > 50000) throw new Error('The stash supports 50,000 entries total.');
      if (!jsonRecord(entry) || !jsonRecord(entry.profile)) continue;
      const profile = entry.profile,
        template = defaults.get(String(profile.kind));
      if (!template) continue;
      if (
        !jsonRecord(profile.settings) ||
        (profile.omitted !== undefined &&
          (!jsonArray(profile.omitted) ||
            !profile.omitted.every((v) => typeof v === 'string' && Object.hasOwn(template, v))))
      )
        throw new Error('Invalid compact Stash settings.');
      const settings = { ...(template as Record<string, SettingValue>), ...profile.settings };
      for (const key of (profile.omitted ?? []) as string[]) {
        if (Object.hasOwn(profile.settings, key))
          throw new Error('Conflicting Stash setting omission.');
        delete settings[key];
      }
      const size = encoder.encode(JSON.stringify(settings)).length;
      if (size > 128 * 1024 || (expandedBytes += size) > 256 * 1024 * 1024)
        throw new Error('Expanded Stash settings exceed the safe size limit.');
      profile.settings = settings;
      delete profile.omitted;
    }
    delete group.settingsDefaults;
  }
}

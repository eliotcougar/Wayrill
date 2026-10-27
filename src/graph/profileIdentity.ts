import { jsonArray } from './xrayJson';
import type { Profile } from '../profiles/import';
import type { SettingValue } from './types';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !jsonArray(v);
function canonical(v: unknown): unknown {
  if (jsonArray(v)) return v.map(canonical);
  if (record(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
export function policyProfileIdentity(profile: Profile): string {
  return JSON.stringify(
    canonical({
      kind: profile.kind,
      settings: Object.fromEntries(Object.entries(profile.settings).filter(([k]) => k !== 'tag')),
    }),
  );
}
// Tags follow configuration identity independently of retained or new subscription row IDs.
// A collision is checked against the full identity before candidates are compiled.
const ids = new WeakMap<
  Profile,
  {
    kind: Profile['kind'];
    values: [string, SettingValue][];
    id: string;
  }
>();
export function policyProfileId(profile: Profile): string {
  const values = Object.entries(profile.settings).filter(([key]) => key !== 'tag');
  // Settings are scalar. Compare their saved values too, so deliberate in-place
  // edits cannot reuse an old identity. Never cache malformed nested settings.
  const cacheable = values.every(([, value]) =>
    ['string', 'number', 'boolean'].includes(typeof value),
  );
  const previous = cacheable ? ids.get(profile) : undefined;
  if (
    previous?.kind === profile.kind &&
    previous.values.length === values.length &&
    values.every(
      ([key, value], i) => previous.values[i][0] === key && Object.is(previous.values[i][1], value),
    )
  )
    return previous.id;
  const value = policyProfileIdentity(profile);
  const id = stableProfileKey(value);
  if (cacheable) ids.set(profile, { kind: profile.kind, values, id });
  return id;
}
export function stableProfileKey(value: string): string {
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => {
      let h = seed;
      for (let i = 0; i < value.length; i++)
        h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
      return h.toString(16).padStart(8, '0');
    })
    .join('');
}

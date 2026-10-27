import { expect, it } from 'vitest';
import { importProfiles, parseStash, serializeStash, stashByteLength, type Stash } from './import';
import { policyProfileId } from '../graph/policySources';
import { getDefinition } from '../graph/catalog';

it('compacts repeated defaults without losing omissions, explicit values, native baselines or identities', () => {
  const groups = importProfiles(
    JSON.stringify({
      protocol: 'shadowsocks',
      tag: '日本 🇯🇵',
      settings: {
        servers: [{ address: 'example.net', port: 443, method: 'aes-128-gcm', password: 'public' }],
      },
    }),
  ).groups;
  const first = groups[0].entries[0];
  groups[0].entries = Array.from({ length: 100 }, (_, i) => ({
    ...first,
    id: `entry-${i}`,
    profile: {
      ...first.profile!,
      settings: { ...first.profile!.settings, muxEnabled: false, muxConcurrency: 0 },
    },
  }));
  delete groups[0].entries[0].profile!.settings.fingerprint;
  const stash: Stash = { format: 'wayrill.stash', version: 3, groups };
  const text = serializeStash(stash),
    reopened = parseStash(text);
  expect(text.length).toBeLessThan(JSON.stringify(stash).length * 0.6);
  expect(reopened).toEqual(stash);
  expect(policyProfileId(reopened.groups[0].entries[0].profile!)).toBe(
    policyProfileId(stash.groups[0].entries[0].profile!),
  );
  expect(stashByteLength(stash)).toBe(new TextEncoder().encode(text).length);
  const defaults = getDefinition(first.profile!.kind).defaults,
    original = defaults.fingerprint;
  try {
    defaults.fingerprint = 'firefox';
    expect(parseStash(text)).toEqual(stash);
  } finally {
    defaults.fingerprint = original;
  }
});
it('rejects malformed templates and ambiguous omissions instead of changing saved settings', () => {
  const stash: Stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: importProfiles('socks://a.example:1080#Public').groups,
  };
  const value = JSON.parse(serializeStash(stash));
  value.groups[0].entries[0].profile.settings.address = 'conflicting.example';
  value.groups[0].entries[0].profile.omitted = ['address'];
  expect(() => parseStash(JSON.stringify(value))).toThrow(/Conflicting/);
  value.groups[0].settingsDefaults = [];
  expect(() => parseStash(JSON.stringify(value))).toThrow(/compact/);
});

it('round-trips a paused group and rejects malformed pause metadata', () => {
  const groups = importProfiles('socks://a.example:1080#Test').groups.map((group) => ({
    ...group,
    maintenancePaused: true,
  }));
  const value: Stash = { format: 'wayrill.stash', version: 3, groups };
  expect(parseStash(serializeStash(value))).toEqual(value);
  const malformed = JSON.parse(serializeStash(value));
  malformed.groups[0].maintenancePaused = 'false';
  expect(() => parseStash(JSON.stringify(malformed))).toThrow(/maintenance/);
});

it.each(
  [undefined, null, [], ['value'], 'value', 3, true, { Authorization: null }].map((headers) => [
    headers,
  ]),
)('rejects non-object or non-string Stash request headers: %j', (headers) => {
  const groups = importProfiles('socks://a.example:1080#Test').groups;
  const malformed = JSON.parse(serializeStash({ format: 'wayrill.stash', version: 3, groups }));
  malformed.groups[0].headers = headers;
  expect(() => parseStash(JSON.stringify(malformed))).toThrow(/stash group/i);
});

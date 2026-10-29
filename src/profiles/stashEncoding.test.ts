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

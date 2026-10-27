import { expect, it } from 'vitest';
import { policyProfileId } from './profileIdentity';
import { refreshPreparedReference, policyProfile } from './policySources';
import { importProfiles, type Profile, type Stash } from '../profiles/import';
it('keeps identities canonical and tag-independent while detecting in-place connection changes', () => {
  const profile: Profile = {
    kind: 'socks-outbound',
    settings: { address: 'a.example', port: 1080, tag: 'first' },
  };
  const first = policyProfileId(profile);
  expect(policyProfileId(profile)).toBe(first);
  profile.settings.tag = 'local-tag';
  expect(policyProfileId(profile)).toBe(first);
  expect(
    policyProfileId({ kind: profile.kind, settings: { port: 1080, address: 'a.example' } }),
  ).toBe(first);
  profile.settings.port = 2080;
  expect(policyProfileId(profile)).not.toBe(first);
  profile.settings.port = 1080;
  expect(policyProfileId(profile)).toBe(first);
  profile.settings.username = 'new';
  expect(policyProfileId(profile)).not.toBe(first);
  delete profile.settings.username;
  expect(policyProfileId(profile)).toBe(first);
});
it('still rejects a saved reference whose profile was mutated after its identity was checked', () => {
  const stash: Stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: importProfiles('socks://a.example:1080#A').groups,
  };
  const ref = policyProfile(stash.groups[0].entries[0]);
  expect(refreshPreparedReference(ref, stash)).toBe(ref);
  ref.profile.settings.port = 2080;
  expect(() => refreshPreparedReference(ref, stash)).toThrow('inconsistent identity');
});

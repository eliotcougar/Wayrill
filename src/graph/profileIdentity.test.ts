import { expect, it } from 'vitest';
import { refreshPreparedReference, policyProfile } from './policySources';
import { importProfiles, type Stash } from '../profiles/import';
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

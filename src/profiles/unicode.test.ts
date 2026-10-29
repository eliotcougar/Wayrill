import { expect, it } from 'vitest';
import { importProfiles } from './import';
import { libraryRows, searchLibrary } from './library';

it('finds decorative Unicode titles with ordinary typed text without rewriting stored names', () => {
  const links = [
    ['𝗝𝗼𝗶𝗻➠@PlanB_net', 'Join➠@PlanB_net'],
    ['Ｆｒｉｅｎｄｌｙ　Ａｐｐ', 'friendly app'],
    ['cafe\u0301', 'café'],
  ];
  for (const [name, query] of links) {
    const stash = importProfiles(
      'vless://public-id@unicode.example.net:443?security=tls#' + encodeURIComponent(name),
    );
    const found = searchLibrary(libraryRows(stash.groups), query);
    expect(found).toHaveLength(1);
    expect(found[0].entry.name).toBe(name);
    expect(libraryRows(stash.groups)[0]).toBe(found[0]);
  }
});

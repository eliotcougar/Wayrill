import { afterEach, expect, it, vi } from 'vitest';
import { checkForUpdates } from './releaseUpdates';

afterEach(() => vi.unstubAllGlobals());

const nextPage = {
  link: '<https://api.github.com/repositories/1436206430/releases?per_page=100&page=2>; rel="next"',
};

function entry(tag_name: string, prerelease: boolean, draft = false) {
  return { tag_name, prerelease, draft };
}

it('uses version order across pages and respects GitHub’s stable and prerelease flags', async () => {
  const firstPage = [entry('v1.0.0-rc.2', true), entry('v2.0.0', false, true)];
  const lastPage = [
    entry('v1.0.0-rc.10', true),
    entry('v0.35.0', false),
    ...Array.from({ length: 98 }, (_, i) => entry(`v0.34.${i}`, false)),
  ];
  const fetchPage = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(firstPage, { headers: nextPage }))
    .mockResolvedValueOnce(Response.json(lastPage));
  vi.stubGlobal('fetch', fetchPage);
  const signal = new AbortController().signal;
  const result = await checkForUpdates('1.0.0-rc.2', signal);
  expect(result).toEqual({
    stable: { tag: 'v0.35.0', version: '0.35.0', comparison: -1 },
    prerelease: { tag: 'v1.0.0-rc.10', version: '1.0.0-rc.10', comparison: 1 },
  });
  expect(fetchPage).toHaveBeenLastCalledWith(
    'https://api.github.com/repos/eliotcougar/Wayrill/releases?per_page=100&page=2',
    expect.objectContaining({ signal, cache: 'no-cache', credentials: 'omit' }),
  );
});

it('surfaces a failed page instead of treating a partial release list as up to date', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([entry('v0.36.9', true)], { headers: nextPage }))
      .mockResolvedValueOnce(new Response('', { status: 429 })),
  );
  await expect(checkForUpdates('0.36.9', new AbortController().signal)).rejects.toThrow('HTTP 429');
});

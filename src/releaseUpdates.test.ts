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
  const firstPage = [entry('v0.36.9', true), entry('v0.36.10', true), entry('v1.0.0', false, true)];
  const fetchPage = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(firstPage, { headers: nextPage }))
    .mockResolvedValueOnce(Response.json([entry('v0.35.0', false), entry('v0.34.0', false)]));
  vi.stubGlobal('fetch', fetchPage);
  const signal = new AbortController().signal;
  const result = await checkForUpdates('0.36.9', signal);
  expect(result).toEqual({
    stable: { tag: 'v0.35.0', version: '0.35.0', comparison: -1 },
    prerelease: { tag: 'v0.36.10', version: '0.36.10', comparison: 1 },
  });
  expect(fetchPage).toHaveBeenLastCalledWith(
    'https://api.github.com/repos/eliotcougar/Wayrill/releases?per_page=100&page=2',
    expect.objectContaining({ signal, cache: 'no-cache', credentials: 'omit' }),
  );
});

it('stops at a full final page and compares prerelease suffixes', async () => {
  const fetchPage = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([
        entry('v1.0.0-rc.2', true),
        entry('v1.0.0-rc.10', true),
        ...Array.from({ length: 98 }, (_, index) => entry(`v0.36.${index}`, true)),
      ]),
    );
  vi.stubGlobal('fetch', fetchPage);
  await expect(checkForUpdates('1.0.0-rc.10', new AbortController().signal)).resolves.toEqual({
    stable: null,
    prerelease: { tag: 'v1.0.0-rc.10', version: '1.0.0-rc.10', comparison: 0 },
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
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

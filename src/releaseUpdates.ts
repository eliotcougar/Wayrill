import { invoke, isTauri } from '@tauri-apps/api/core';
import { compare, valid } from 'semver';
import { jsonArray, jsonRecord } from './graph/xrayJson';

const releaseApi = 'https://api.github.com/repos/eliotcougar/Wayrill/releases';
const releasePages = 'https://github.com/eliotcougar/Wayrill/releases';

type Release = { tag: string; version: string; comparison: number };
export type ReleaseUpdates = { stable: Release | null; prerelease: Release | null };

export async function checkForUpdates(
  installed: string,
  signal: AbortSignal,
): Promise<ReleaseUpdates> {
  const updates: ReleaseUpdates = { stable: null, prerelease: null };
  for (let page = 1; ; page++) {
    const response = await fetch(`${releaseApi}?per_page=100&page=${page}`, {
      signal,
      cache: 'no-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const releases: unknown = await response.json();
    if (!jsonArray(releases)) throw new Error('GitHub returned an invalid release list.');
    for (const release of releases) {
      if (
        !jsonRecord(release) ||
        typeof release.tag_name !== 'string' ||
        typeof release.prerelease !== 'boolean' ||
        typeof release.draft !== 'boolean'
      ) {
        throw new Error('GitHub returned an invalid release entry.');
      }
      const tag = release.tag_name;
      if (release.draft || !/^v?\d[0-9A-Za-z.+-]*$/.test(tag) || !valid(tag)) continue;
      const channel = release.prerelease ? 'prerelease' : 'stable';
      const previous = updates[channel];
      if (!previous || compare(tag, previous.tag) > 0) {
        updates[channel] = {
          tag,
          version: tag.replace(/^v/, ''),
          comparison: compare(tag, installed),
        };
      }
    }
    // GitHub can use a different URL for the next link. Keep each request on
    // the fixed releases endpoint allowed by the desktop's content policy.
    if (!response.headers.get('link')?.includes('rel="next"')) return updates;
  }
}

export async function openReleasePage(tag?: string): Promise<void> {
  if (isTauri()) {
    await invoke('open_release_page', { tag: tag ?? null });
  } else {
    window.open(tag ? `${releasePages}/tag/${tag}` : releasePages, '_blank', 'noopener,noreferrer');
  }
}

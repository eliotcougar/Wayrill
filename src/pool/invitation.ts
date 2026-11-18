export type PoolSource = { kind: 'folder' | 'url'; address: string; invite: string };

export const invitePattern = /^wp1\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
export const inviteLength = 101;
const heading = 'Wayrill Pool invitation';

export function isPoolShare(address: string) {
  if (!address.startsWith('\\\\')) return false;
  const [host, ...parts] = address.slice(2).replace(/\\$/, '').split('\\');
  return (
    !!host &&
    /^[^\\/\s:*?"<>|]+$/.test(host) &&
    host !== '.' &&
    parts.length > 0 &&
    parts.every((part) => /^[^\\/:*?"<>|]+$/.test(part))
  );
}

export function formatPoolInvitation(source: PoolSource) {
  return [heading, source.address, source.invite].join('\n');
}

export function parsePoolInvitation(text: string): PoolSource | undefined {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const [title, address, invite] = lines;
  if (lines.length !== 3 || title !== heading || !address || !invitePattern.test(invite)) return;
  return { kind: /^https?:\/\//i.test(address) ? 'url' : 'folder', address, invite };
}

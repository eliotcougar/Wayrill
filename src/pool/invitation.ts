export type PoolSource = { kind: 'folder' | 'url'; address: string; invite: string };

export const invitePattern = /^wp1\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
const legacyHeading = 'Wayrill Pool invitation';
const codePrefix = 'WP2';
const codeEnd = ':';
const destinationSchemes = { H: 'https://', L: 'http://', U: '', F: '' } as const;
const recipientBytes = 16;
const accessBytes = recipientBytes + 32;
const maxAddressBytes = 2048; // Matches the service's Pool source limit.
export const poolInvitationMaxLength =
  codePrefix.length + 1 + Math.ceil(((accessBytes + maxAddressBytes) * 3) / 2) + codeEnd.length;

// A subset of QR alphanumeric mode without whitespace, with ':' reserved to frame the end.
// Like Base45, this alphabet fits each pair of bytes into three characters.
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$%*+-./';
const radix = alphabet.length;

function encodeCodeBytes(bytes: Uint8Array) {
  let result = '';
  for (let index = 0; index < bytes.length; index += 2) {
    const pair = index + 1 < bytes.length;
    const value = pair ? bytes[index] * 256 + bytes[index + 1] : bytes[index];
    result += alphabet[value % radix] + alphabet[Math.floor(value / radix) % radix];
    if (pair) result += alphabet[Math.floor(value / (radix * radix))];
  }
  return result;
}

function decodeCodeBytes(payload: string) {
  if (payload.length % 3 === 1) return;
  const bytes = new Uint8Array(Math.floor((payload.length * 2) / 3));
  let offset = 0;
  for (let index = 0; index < payload.length; index += 3) {
    const pair = index + 2 < payload.length;
    const low = alphabet.indexOf(payload[index]);
    const middle = alphabet.indexOf(payload[index + 1]);
    const high = pair ? alphabet.indexOf(payload[index + 2]) : 0;
    if (low < 0 || middle < 0 || high < 0) return;
    const value = low + middle * radix + high * radix * radix;
    if (value > (pair ? 0xffff : 0xff)) return;
    if (pair) bytes[offset++] = value >>> 8;
    bytes[offset++] = value & 0xff;
  }
  return bytes;
}

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
  const access = invitePattern.exec(source.invite);
  if (!access) throw new Error('The Pool invitation access key is invalid.');

  const address = source.address.trim();
  let destination: keyof typeof destinationSchemes = 'F';
  if (source.kind === 'url') {
    destination = 'U';
    if (address.startsWith(destinationSchemes.H)) destination = 'H';
    if (address.startsWith(destinationSchemes.L)) destination = 'L';
  }
  const scheme = destinationSchemes[destination];
  const location = new TextEncoder().encode(address.slice(scheme.length));
  if (
    !location.length ||
    scheme.length + location.length > maxAddressBytes ||
    address.includes('\0') ||
    /[\r\n]/.test(address)
  ) {
    throw new Error('The Pool invitation source is missing or invalid.');
  }

  const [, recipient, key] = access;
  const bytes = new Uint8Array(accessBytes + location.length);
  bytes.set(Uint8Array.from((recipient + key).match(/../g)!, (byte) => Number.parseInt(byte, 16)));
  bytes.set(location, accessBytes);
  return codePrefix + destination + encodeCodeBytes(bytes) + codeEnd;
}

export function parsePoolInvitation(text: string): PoolSource | undefined {
  const invitation = text.trim();
  if (invitation.startsWith(codePrefix)) {
    if (!invitation.endsWith(codeEnd) || invitation.length > poolInvitationMaxLength) return;
    const destination = invitation[codePrefix.length];
    if (destination !== 'H' && destination !== 'L' && destination !== 'U' && destination !== 'F')
      return;
    const bytes = decodeCodeBytes(invitation.slice(codePrefix.length + 1, -codeEnd.length));
    if (!bytes || bytes.length <= accessBytes) return;
    const scheme = destinationSchemes[destination];
    if (scheme.length + bytes.length - accessBytes > maxAddressBytes) return;

    let location: string;
    try {
      location = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(accessBytes),
      );
    } catch {
      return;
    }
    if (location.includes('\0') || /[\r\n]/.test(location)) return;
    const access = Array.from(bytes.subarray(0, accessBytes), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const recipientEnd = recipientBytes * 2;
    return {
      kind: destination === 'F' ? 'folder' : 'url',
      address: scheme + location,
      invite: `wp1.${access.slice(0, recipientEnd)}.${access.slice(recipientEnd)}`,
    };
  }

  const lines = invitation.split(/\r?\n/).map((line) => line.trim());
  const [title, address, invite] = lines;
  if (lines.length !== 3 || title !== legacyHeading || !address || !invitePattern.test(invite))
    return;
  return { kind: /^https?:\/\//i.test(address) ? 'url' : 'folder', address, invite };
}

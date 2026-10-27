import { jsonRecord, parseJson } from '../graph/xrayJson';

export const MAX_BACKUP_BYTES = 192 * 1024 * 1024;
export const MAX_CONTENT_BYTES = 128 * 1024 * 1024;
const iterations = 600_000;
const encoder = new TextEncoder();
const header = { format: 'wayrill.backup', version: 2 } as const;
const additionalData = (version: number) =>
  encoder.encode(`wayrill.backup:${version}:AES-256-GCM:PBKDF2-SHA256:600000`);

function readEnvelope(text: string) {
  if (encoder.encode(text).length > MAX_BACKUP_BYTES)
    throw new Error('Backup files must be smaller than 192 MiB.');
  let value: unknown;
  try {
    value = parseJson(text);
  } catch {
    throw new Error('This is not a valid Wayrill backup.');
  }
  if (
    !jsonRecord(value) ||
    value.format !== header.format ||
    (value.version !== 1 && value.version !== 2)
  )
    throw new Error('This backup format or version is not supported.');
  if (typeof value.encrypted !== 'boolean') throw new Error('Invalid backup envelope.');
  return value;
}

export function backupIsEncrypted(text: string): boolean {
  return readEnvelope(text).encrypted === true;
}

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(parts.join(''));
}
function bytes(text: unknown, length?: number): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw new Error('Invalid encrypted backup.');
  let raw: string;
  try {
    raw = atob(text);
  } catch {
    throw new Error('Invalid encrypted backup.');
  }
  if ((length !== undefined && raw.length !== length) || raw.length > MAX_CONTENT_BYTES + 16)
    throw new Error('Invalid encrypted backup size.');
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function key(password: string, salt: Uint8Array<ArrayBuffer>) {
  const encoded = encoder.encode(password);
  if (!encoded.length || encoded.length > 1024)
    throw new Error('Enter a password of at most 1,024 UTF-8 bytes.');
  try {
    const material = await crypto.subtle.importKey('raw', encoded, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    encoded.fill(0);
  }
}
export async function encodeBackup(content: unknown, password?: string): Promise<string> {
  if (
    !jsonRecord(content) ||
    ['format', 'version', 'encrypted'].some((k) => Object.hasOwn(content, k))
  )
    throw new Error('Invalid backup contents.');
  const file = (value: unknown) => {
    const text = JSON.stringify(value, null, 2) + '\n';
    if (encoder.encode(text).length > MAX_BACKUP_BYTES)
      throw new Error('Backup files must be smaller than 192 MiB.');
    return text;
  };
  const text = JSON.stringify(content, null, 2);
  const plain = encoder.encode(text);
  if (plain.length > MAX_CONTENT_BYTES) throw new Error('Backup contents exceed 128 MiB.');
  if (password === undefined) return file({ ...header, encrypted: false, ...content });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const secret = await key(password, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(header.version), tagLength: 128 },
      secret,
      plain,
    );
    return file({
      ...header,
      encrypted: true,
      cipher: 'AES-256-GCM',
      kdf: { name: 'PBKDF2-SHA256', iterations, salt: base64(salt) },
      iv: base64(iv),
      data: base64(new Uint8Array(encrypted)),
    });
  } finally {
    plain.fill(0);
  }
}
export async function decodeBackup(text: string, password?: string): Promise<unknown> {
  const value = readEnvelope(text);
  if (!value.encrypted) {
    const unwrapped = { ...value };
    for (const key of ['format', 'version', 'encrypted']) delete unwrapped[key];
    const content: unknown = value.version === 1 ? value.data : unwrapped;
    if (encoder.encode(JSON.stringify(content)).length > MAX_CONTENT_BYTES)
      throw new Error('Backup contents exceed 128 MiB.');
    return content;
  }
  if (
    value.cipher !== 'AES-256-GCM' ||
    !jsonRecord(value.kdf) ||
    value.kdf.name !== 'PBKDF2-SHA256' ||
    value.kdf.iterations !== iterations
  )
    throw new Error('This backup encryption format is not supported.');
  const salt = bytes(value.kdf.salt, 16),
    iv = bytes(value.iv, 12),
    data = bytes(value.data);
  if (data.length < 16) throw new Error('Invalid encrypted backup.');
  if (password === undefined) throw new Error('Enter the backup password.');
  const secret = await key(password, salt);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: additionalData(Number(value.version)),
        tagLength: 128,
      },
      secret,
      data,
    );
  } catch {
    throw new Error('Incorrect password or damaged backup.');
  }
  try {
    return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new Error('Invalid backup contents.');
  } finally {
    new Uint8Array(plain).fill(0);
  }
}

import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backupIsEncrypted, decodeBackup, encodeBackup } from './codec';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
const content = {
  name: '🍃 日本語 · русский',
  credentials: 'test-only-password',
  omitted: null,
  zero: 0,
  disabled: false,
};
it('round trips readable and encrypted backups without machine-bound storage', async () => {
  const plain = await encodeBackup(content);
  expect(plain).toContain('\n  "name":');
  expect(JSON.parse(plain)).not.toHaveProperty('data');
  expect(JSON.parse(plain)).toMatchObject({ format: 'wayrill.backup', version: 2, ...content });
  expect(backupIsEncrypted(plain)).toBe(false);
  expect(await decodeBackup(plain)).toEqual(content);
  const encrypted = await encodeBackup(content, ' тестовая 🔐 passphrase ');
  expect(backupIsEncrypted(encrypted)).toBe(true);
  expect(encrypted).not.toContain(content.credentials);
  expect(await decodeBackup(encrypted, ' тестовая 🔐 passphrase ')).toEqual(content);
  await expect(decodeBackup(encrypted, 'тестовая 🔐 passphrase')).rejects.toThrow(
    'Incorrect password',
  );
});
it('uses fresh salts and nonces and authenticates ciphertext', async () => {
  const first = await encodeBackup(content, 'long test password');
  const second = await encodeBackup(content, 'long test password');
  expect(first).not.toEqual(second);
  const edited = JSON.parse(first) as { data: string; iv: string; kdf: { salt: string } };
  const other = JSON.parse(second) as typeof edited;
  expect(edited.iv).not.toEqual(other.iv);
  expect(edited.kdf.salt).not.toEqual(other.kdf.salt);
  edited.data = (edited.data[0] === 'A' ? 'B' : 'A') + edited.data.slice(1);
  await expect(decodeBackup(JSON.stringify(edited), 'long test password')).rejects.toThrow(
    'damaged backup',
  );
});
it('rejects unknown formats, hostile work factors and truncated authentication tags', async () => {
  expect(() => backupIsEncrypted('{')).toThrow('valid Wayrill');
  expect(() => backupIsEncrypted('{"format":"wayrill.backup","version":99}')).toThrow(
    'not supported',
  );
  const encrypted = await encodeBackup(content, 'long test password');
  await expect(decodeBackup(encrypted)).rejects.toThrow('Enter the backup password');
  const edited = JSON.parse(encrypted) as { data: string; kdf: { iterations: number } };
  edited.kdf.iterations = 2147483647;
  await expect(decodeBackup(JSON.stringify(edited), 'long test password')).rejects.toThrow(
    'not supported',
  );
  edited.kdf.iterations = 600000;
  edited.data = 'AQ==';
  await expect(decodeBackup(JSON.stringify(edited), 'long test password')).rejects.toThrow(
    'Invalid encrypted backup',
  );
});

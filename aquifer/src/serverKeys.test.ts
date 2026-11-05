import { createPrivateKey, createPublicKey } from 'node:crypto';
import { expect, it } from 'vitest';
import { generateServerKeys, generateShortId, serverPublicKey } from './serverKeys';

it.each([false, true])(
  'generates a consistent X25519 pair in the server encoding (WireGuard=%s)',
  async (wireguard) => {
    const pair = await generateServerKeys(wireguard);
    for (const key of Object.values(pair)) expect(Buffer.from(key, 'base64url').length).toBe(32);
    const d = Buffer.from(pair.privateKey, 'base64url').toString('base64url');
    const x = Buffer.from(pair.publicKey, 'base64url').toString('base64url');
    const key = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d, x }, format: 'jwk' });
    expect(createPublicKey(key).export({ format: 'jwk' }).x).toBe(x);
    expect(pair.privateKey.endsWith('=')).toBe(wireguard);
    expect(await serverPublicKey(pair.privateKey, wireguard)).toBe(pair.publicKey);
  },
);
it('generates supported REALITY short IDs', () => {
  expect(generateShortId()).toMatch(/^[a-f0-9]{16}$/);
});

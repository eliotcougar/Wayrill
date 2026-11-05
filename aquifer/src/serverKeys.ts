/** Generate locally; no native command, server access, or persisted key material. */
export async function generateServerKeys(wireguard: boolean) {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const key = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (!key.d || !key.x) throw new Error('This WebView cannot export X25519 keys.');
  const encode = (text: string) =>
    wireguard
      ? text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
      : text;
  return { privateKey: encode(key.d), publicKey: encode(key.x) };
}
export async function serverPublicKey(privateKey: string, wireguard: boolean) {
  const raw = Uint8Array.from(atob(privateKey.replace(/-/g, '+').replace(/_/g, '/')), (char) =>
    char.charCodeAt(0),
  );
  if (raw.length !== 32) throw new Error('Expected a 32-byte private key.');
  // RFC 8410 X25519 PrivateKeyInfo. The crypto provider derives the public key.
  const pkcs8 = new Uint8Array([
    0x30,
    0x2e,
    2,
    1,
    0,
    0x30,
    5,
    6,
    3,
    0x2b,
    0x65,
    0x6e,
    4,
    0x22,
    4,
    0x20,
    ...raw,
  ]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, [
    'deriveBits',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (!jwk.x) throw new Error('Public key unavailable.');
  return wireguard
    ? jwk.x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (jwk.x.length % 4)) % 4)
    : jwk.x;
}
export function generateShortId() {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

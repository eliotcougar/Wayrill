export function decodeBase64(text: string): string {
  const cleaned = text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) throw new Error('Invalid Base64 subscription.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, '=')), (c) =>
        c.charCodeAt(0),
      ),
    );
  } catch {
    throw new Error('Invalid Base64 or UTF-8 subscription.');
  }
}

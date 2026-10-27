/** Windows tools commonly save UTF-16 with a BOM; unmarked imports are UTF-8.
 * Reject undecodable input rather than replacing names or credentials silently. */
export function decodeImportText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Save the file as UTF-8 or UTF-16 with a byte-order mark.');
  }
}

export async function readImportText(file: Pick<Blob, 'arrayBuffer'>): Promise<string> {
  return decodeImportText(await file.arrayBuffer());
}

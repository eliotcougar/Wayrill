import { expect, it } from 'vitest';
import { decodeImportText, readImportText } from './importText';

const text = JSON.stringify({
  name: 'Россия 中文 日本語 نام 🌍',
  path: 'C:\\Программы\\应用.exe',
});
function utf16(value: string, little: boolean): ArrayBuffer {
  const bytes = new Uint8Array(2 + value.length * 2),
    view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, little);
  for (let i = 0; i < value.length; i++) view.setUint16(2 + i * 2, value.charCodeAt(i), little);
  return bytes.buffer;
}
it('preserves names, paths and surrogate pairs in UTF-8 and both marked UTF-16 orders', async () => {
  for (const bytes of [
    new TextEncoder().encode(text).buffer,
    new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]).buffer,
    utf16(text, true),
    utf16(text, false),
  ]) {
    expect(decodeImportText(bytes)).toBe(text);
    expect(await readImportText(new Blob([bytes]))).toBe(text);
  }
});
it('rejects truncated Unicode, lone surrogates and legacy bytes without silently altering data', () => {
  for (const bytes of [
    [0xd0],
    [0xff],
    [0xff, 0xfe, 0x61],
    [0xfe, 0xff, 0],
    [0xff, 0xfe, 0, 0xd8],
    [0xfe, 0xff, 0xdc, 0],
  ])
    expect(() => decodeImportText(new Uint8Array(bytes).buffer)).toThrow('UTF-8 or UTF-16');
});

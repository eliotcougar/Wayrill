import { expect, it } from 'vitest';
import { boundedText } from './text';
it.each(['🇩🇪', '👩🏽‍💻', '❤️', 'e\u0301'])('never splits %s at the storage boundary', (glyph) => {
  const original = 'a'.repeat(127) + glyph;
  expect(boundedText(original, 128)).toBe('a'.repeat(127));
  expect(boundedText('a'.repeat(128 - glyph.length) + glyph, 128)).toBe(
    'a'.repeat(128 - glyph.length) + glyph,
  );
});

import { expect, it } from 'vitest';
import { compactTagId, generatedTag, observedTag, isGeneratedTag } from './tags';

it('preserves identity bits in unpadded Base64url, including Unicode tags, and reserves private namespaces', () => {
  expect(compactTagId('00000000000000000000000000000000')).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  expect(compactTagId('ffffffffffffffffffffffffffffffff')).toBe('_____________________w');
  expect(observedTag('媒体 📺')).toBe('wob-JtFz8WJJ4AWXdFsPnwvQgQ');
  const tags = new Set(Array.from({ length: 5000 }, (_, i) => generatedTag('wpp', `member-${i}`)));
  expect(tags.size).toBe(5000);
  expect([...tags].every((tag) => /^wpp-[A-Za-z0-9_-]{22}$/.test(tag))).toBe(true);
  expect(isGeneratedTag('wdr-n-user')).toBe(true);
  expect(isGeneratedTag('my-outbound')).toBe(false);
});

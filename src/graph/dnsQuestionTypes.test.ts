import { expect, it } from 'vitest';
import { hasQuestionType, toggleQuestionType } from './dnsQuestionTypes';
it('splits ranges without expanding them and merges adjacent selections', () => {
  expect(toggleQuestionType('0-65535', 28, false)).toBe('0-27,29-65535');
  expect(toggleQuestionType('0-27,29-65535', 28, true)).toBe('0-65535');
  expect(toggleQuestionType('1,15,16,28,garbage', 15, false)).toBe('1,16,28,garbage');
  expect(hasQuestionType('64-65,invalid', 65)).toBe(true);
  expect(hasQuestionType('', 1)).toBe(false);
});

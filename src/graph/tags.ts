import { stableProfileKey } from './profileIdentity';

// Base64url: all 64 symbols are safe in JSON, URLs and exact selector expressions.
// Keep the existing 128-bit identities; only their representation changes.
export function compactTagId(hex: string): string {
  return btoa(String.fromCharCode(...hex.match(/../g)!.map((part) => parseInt(part, 16))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function generatedTag(prefix: string, ...identity: (string | number)[]): string {
  return `${prefix}-${compactTagId(stableProfileKey(JSON.stringify(identity)))}`;
}
export const observedTag = (tag: string) => `wob-${compactTagId(stableProfileKey(tag))}`;
export const generatedTagPrefixes = [
  'wr-',
  'wri-',
  'wds-',
  'wdg-',
  'wpp-',
  'wpi-',
  'wpe-',
  'wpm-',
  'wob-',
  'woi-',
  'wc-',
  'wcr-',
  'wte-',
  'wt-',
  'wtr-',
  'wdr-',
  'wdo-',
  'wi6-',
  'wrr-',
];
export const isGeneratedTag = (tag: string) =>
  generatedTagPrefixes.some((prefix) => tag.startsWith(prefix));

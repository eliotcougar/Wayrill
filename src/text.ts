const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Normalize only search text; preserve displayed names, tags and routing match expressions. */
export const searchText = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en');

/** Storage limits count UTF-16 units; never split a visible character at that boundary. */
export function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > limit) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

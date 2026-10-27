import { LIMITS, CONFIG_LIMIT_LABEL } from '../limits';
/** Keep JSON arrays unknown until their elements are validated. */
export const jsonArray = (value: unknown): value is unknown[] => Array.isArray(value);
/** Show malformed object values as JSON rather than the unhelpful [object Object]. */
export function jsonText(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}
// Strict JSON/JSONC reader: comments are accepted, duplicate keys and imprecise
// integers are not silently collapsed before the preservation contract is made.
export const jsonRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !jsonArray(v);
/** JSON.parse is a boundary, never an implicit source of any. */
export const parseJson = (text: string): unknown => JSON.parse(text);
export function parseJsonObject(text: string): Record<string, unknown> {
  const value = parseJson(text);
  if (!jsonRecord(value)) throw new Error('Enter a JSON object.');
  return value;
}
export function parseJsonArray(text: string): unknown[] {
  const value = parseJson(text);
  if (!jsonArray(value)) throw new Error('Enter a JSON array.');
  return value;
}
export const cloneJson = <T>(v: T): T =>
  v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
export function checkJson(v: unknown, depth = 0): void {
  if (depth > 64) throw new Error('Xray JSON nesting exceeds 64 levels.');
  if (
    typeof v === 'number' &&
    (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v)))
  )
    throw new Error('A JSON integer cannot be represented precisely.');
  if (jsonArray(v)) for (const item of v) checkJson(item, depth + 1);
  else if (jsonRecord(v))
    for (const [key, value] of Object.entries(v)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('Unsafe JSON property.');
      checkJson(value, depth + 1);
    }
}
export interface JsonPropertyToken {
  key: string;
  path: string[];
  start: number;
  end: number;
}
export function parseXrayJson(
  text: string,
  onProperty?: (token: JsonPropertyToken) => void,
): unknown {
  if (new TextEncoder().encode(text).length > LIMITS.configBytes)
    throw new Error(`Xray configurations must be at most ${CONFIG_LIMIT_LABEL}.`);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (): never => {
    throw new Error(`Invalid Xray JSON near character ${i + 1}.`);
  };
  function space() {
    for (;;) {
      while (/\s/.test(text[i] ?? '') && i < text.length) i++;
      if (text.slice(i, i + 2) === '//') {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (text.slice(i, i + 2) === '/*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail();
        i = end + 2;
      } else break;
    }
  }
  function string(): string {
    const start = i++;
    let escaped = false;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"' && !escaped) {
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          fail();
        }
      }
      if (c === '\\' && !escaped) escaped = true;
      else escaped = false;
    }
    return fail();
  }
  function value(depth: number, path: string[] = []): unknown {
    if (depth > 64) throw new Error('Xray JSON nesting exceeds 64 levels.');
    space();
    const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++;
      const out: Record<string, unknown> = {};
      const keys = new Set<string>();
      space();
      if (text[i] === '}') {
        i++;
        return out;
      }
      for (;;) {
        space();
        if (text[i] !== '"') fail();
        const start = i;
        const key = string();
        onProperty?.({ key, path, start, end: i });
        if (keys.has(key)) throw new Error('Duplicate JSON property; import would be ambiguous.');
        keys.add(key);
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw new Error('Unsafe JSON property.');
        space();
        if (text[i++] !== ':') fail();
        out[key] = value(depth + 1, onProperty ? [...path, key] : []);
        space();
        if (text[i] === '}') {
          i++;
          return out;
        }
        if (text[i++] !== ',') fail();
      }
    }
    if (c === '[') {
      i++;
      const out: unknown[] = [];
      space();
      if (text[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1, onProperty ? [...path, String(out.length)] : []));
        space();
        if (text[i] === ']') {
          i++;
          return out;
        }
        if (text[i++] !== ',') fail();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(i),
    )?.[0];
    if (!token) return fail();
    i += token.length;
    const out: unknown = JSON.parse(token);
    checkJson(out);
    return out;
  }
  const out = value(0);
  space();
  if (i !== text.length) fail();
  return out;
}
export const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (jsonArray(a) && jsonArray(b))
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (jsonRecord(a) && jsonRecord(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  return Object.is(a, b);
};
export function jsonDifferences(a: unknown, b: unknown, path = ''): string[] {
  if (jsonEqual(a, b)) return [];
  if (jsonRecord(a) && jsonRecord(b))
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
      jsonDifferences(a[k], b[k], `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`),
    );
  if (jsonArray(a) && jsonArray(b) && a.length === b.length)
    return a.flatMap((v, i) => jsonDifferences(v, b[i], `${path}/${i}`));
  return [path || '/'];
}

export function valueAt(root: unknown, path: string[]): unknown {
  for (const part of path) {
    if (jsonArray(root)) {
      root = root[Number(part)];
    } else if (jsonRecord(root)) {
      root = root[Object.keys(root).find((k) => k.toLowerCase() === part.toLowerCase()) ?? part];
    } else return undefined;
  }
  return root;
}

// Go's JSON loader matches field names case-insensitively. Preserve spelling when
// editing a mapped field (e.g. probeUrl) instead of adding a competing alias.
export function patchProjection(original: unknown, baseline: unknown, current: unknown): unknown {
  if (jsonEqual(baseline, current)) return cloneJson(original);
  if (jsonRecord(baseline) && jsonRecord(current)) {
    const result = jsonRecord(original) ? cloneJson(original) : {};
    for (const key of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
      if (jsonEqual(baseline[key], current[key])) continue;
      const spellings = Object.keys(result).filter((k) => k.toLowerCase() === key.toLowerCase());
      if (spellings.length > 1)
        throw new Error(
          'Conflicting native field spellings; edit the native JSON to resolve them.',
        );
      const actual = spellings[0] ?? key;
      if (!Object.hasOwn(current, key)) delete result[actual];
      else result[actual] = patchProjection(result[actual], baseline[key], current[key]);
    }
    return result;
  }
  return cloneJson(current);
}

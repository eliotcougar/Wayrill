import { jsonRecord } from './graph/xrayJson';

export function propertyKey(object: Record<string, unknown>, name: string) {
  return Object.keys(object).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
}
export const get = (object: Record<string, unknown>, name: string): unknown =>
  object[propertyKey(object, name)];
export const objectAt = (
  object: Record<string, unknown>,
  name: string,
): Record<string, unknown> => {
  const value = get(object, name);
  return jsonRecord(value) ? value : {};
};
export function setProperty(
  object: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...object };
  if (value === undefined) delete next[propertyKey(object, key)];
  else
    Object.defineProperty(next, propertyKey(object, key), {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return next;
}

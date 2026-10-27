import { jsonArray, parseJson } from './xrayJson';
import type { RuleNodeData, SettingDefinition } from './types';
type Settings = RuleNodeData['settings'];

export function isFieldVisible(field: SettingDefinition, settings: Settings): boolean {
  return (
    !field.visibleWhen ||
    Object.entries(field.visibleWhen).every(([key, expected]) =>
      jsonArray(expected) ? expected.includes(settings[key]) : settings[key] === expected,
    )
  );
}
export function fieldProblem(field: SettingDefinition, settings: Settings): string | null {
  if (
    !isFieldVisible(field, settings) ||
    (field.section === 'fragment' && !settings.fragmentEnabled && !settings.finalFragmentEnabled)
  )
    return null;
  const value = settings[field.key];
  if (value === undefined && field.optional) return null;
  if (field.type === 'boolean') return typeof value === 'boolean' ? null : 'Choose on or off.';
  if (field.type === 'number')
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= (field.min ?? -Infinity) &&
      value <= (field.max ?? Infinity)
      ? null
      : `Enter a whole number from ${field.min ?? 0} to ${field.max ?? 'the supported maximum'}.`;
  if (typeof value !== 'string' || value.length > (field.maxLength ?? 4096))
    return 'This value is too long or has the wrong type.';
  if (field.options && !field.options.includes(value)) return 'Choose a supported option.';
  if ((field.required ?? field.type === 'text') && !value.trim()) return 'This field is required.';
  if (field.type === 'json' && value.trim()) {
    try {
      const parsed: unknown = parseJson(value);
      if (
        field.jsonShape === 'array'
          ? !jsonArray(parsed)
          : !parsed || typeof parsed !== 'object' || jsonArray(parsed)
      )
        return `Enter a JSON ${field.jsonShape ?? 'object'}.`;
      if (
        field.jsonItems === 'nonemptyStrings' &&
        jsonArray(parsed) &&
        parsed.some((item) => typeof item !== 'string' || !item.trim())
      )
        return 'Enter an array of nonempty rule strings.';
    } catch {
      return 'Enter valid JSON.';
    }
  }
  return null;
}

import { parseXrayJson as parse, type JsonPropertyToken } from '@wayrill/core/xrayJson';
import { LIMITS } from '../limits';
export * from '@wayrill/core/xrayJson';
export const parseXrayJson = (
  text: string,
  onProperty?: (token: JsonPropertyToken) => void,
): unknown => parse(text, onProperty, LIMITS.configBytes);

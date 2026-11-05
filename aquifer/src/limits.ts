// Public resource budget. Rust boundary constants are checked against this same file.
import limits from '../service/limits.json';
export const LIMITS = Object.freeze(limits);
export const CONFIG_LIMIT_LABEL = `${LIMITS.configBytes / 1024 / 1024} MiB`;
export const OUTBOUND_LIMIT_LABEL = LIMITS.maxOutbounds.toLocaleString('en-US');

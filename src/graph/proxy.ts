import { jsonRecord, valueAt, jsonText, jsonArray } from './xrayJson';
import type { CapturePlan } from './capture';

function ambiguousKeys(value: unknown): boolean {
  if (!jsonRecord(value)) return false;
  const keys = Object.keys(value).map((key) => key.toLowerCase());
  return new Set(keys).size !== keys.length;
}

// WinINet and the subscription downloader send ordinary unauthenticated HTTP.
// SOCKS/Mixed also accept HTTP, but an encrypted/authenticated transport cannot
// be adopted as a system HTTP proxy merely because its protocol name matches.
export function httpProxyInputs(
  config: Record<string, unknown> | null,
  capture?: CapturePlan | null,
): Record<string, unknown>[] {
  if (!jsonArray(config?.inbounds)) return [];
  const privateTags = new Set(capture?.inputs.map((input) => input.tag));
  return config.inbounds.filter(jsonRecord).filter((input) => {
    // Capture relays acquire private credentials at runtime; their saved
    // noauth template must never be offered to ordinary proxy clients.
    if (privateTags.has(String(input.tag))) return false;
    if (
      !['http', 'mixed', 'socks'].includes(String(input.protocol)) ||
      input.listen !== '127.0.0.1'
    )
      return false;
    if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535)
      return false;
    const settings = valueAt(input, ['settings']);
    const accounts = valueAt(settings, ['accounts']) ?? valueAt(settings, ['users']);
    if (valueAt(settings, ['auth']) === 'password' || (jsonArray(accounts) && accounts.length > 0))
      return false;
    const stream = valueAt(input, ['streamSettings']);
    if (
      !['raw', 'tcp'].includes(
        jsonText(valueAt(stream, ['method']) ?? valueAt(stream, ['network']) ?? 'raw'),
      ) ||
      !['none', ''].includes(jsonText(valueAt(stream, ['security']) ?? 'none'))
    )
      return false;
    const transport = valueAt(stream, ['rawSettings']) ?? valueAt(stream, ['tcpSettings']);
    const header = valueAt(transport, ['header']);
    if ([input, settings, stream, transport, header].some(ambiguousKeys)) return false;
    const type = valueAt(header, ['type']);
    return !type || type === 'none';
  });
}

export function httpProxyPorts(
  config: Record<string, unknown> | null,
  capture?: CapturePlan | null,
): number[] {
  return httpProxyInputs(config, capture).map((input) => Number(input.port));
}

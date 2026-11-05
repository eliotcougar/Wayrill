import { jsonText } from './xrayJson';
import { isIpLiteral } from './addressValidation';

export function listenerProblem(input: Record<string, unknown>): string | null {
  if (input.protocol === 'tun') return null;
  if (input.listen !== 'localhost' && !isIpLiteral(jsonText(input.listen ?? '')))
    return 'Use an IPv4 or IPv6 listen address, or localhost.';
  if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535)
    return 'Listen port must be an integer from 1 to 65535.';
  return null;
}

// Go's unspecified IPv6 socket accepts IPv4 too. Normalize IPv4-mapped IPv6
// and alternate IPv6 spellings so Check and service activation agree.
function canonicalAddress(address: string): string {
  if (address === 'localhost') return '127.0.0.1';
  if (!address.includes(':')) return address;
  try {
    const ip = new URL(`http://[${address.replace(/^\[|\]$/g, '')}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ip);
    if (mapped) {
      const high = parseInt(mapped[1], 16),
        low = parseInt(mapped[2], 16);
      return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
    }
    return ip;
  } catch {
    return address;
  }
}

export function listenerEndpointsConflict(first: string, second: string): boolean {
  const parse = (key: string) => /^(tcp|udp):(.+):(\d+)$/.exec(key);
  const a = parse(first),
    b = parse(second);
  if (!a || !b || a[1] !== b[1] || Number(a[3]) !== Number(b[3])) return false;
  const x = canonicalAddress(a[2]),
    y = canonicalAddress(b[2]);
  return x === y || x === '::' || y === '::' || x === '0.0.0.0' || y === '0.0.0.0';
}

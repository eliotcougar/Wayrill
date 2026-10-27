import { isIpLiteral } from './addressValidation';

/** Numeric CIDR bounds shared by routing intersections and network diagnostics. */
export function subnet(text: string): { family: number; low: bigint; high: bigint } | undefined {
  const [address, rawMask] = text.split('/');
  const family = address.includes(':') ? 128 : 32;
  const mask = rawMask === undefined ? family : Number(rawMask);
  if (!Number.isInteger(mask) || mask < 0 || mask > family || text.startsWith('!')) return;
  let number: bigint;
  if (family === 32) {
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some((v) => !/^\d+$/.test(v) || Number(v) > 255)) return;
    number = parts.reduce((a, v) => (a << 8n) | BigInt(v), 0n);
  } else {
    if (address.includes('.') || address.split('::').length > 2) return;
    const halves = address.split('::'),
      left = halves[0] ? halves[0].split(':') : [],
      right = halves[1] ? halves[1].split(':') : [];
    const words =
      halves.length === 1
        ? left
        : [
            ...left,
            ...Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => '0'),
            ...right,
          ];
    if (words.length !== 8 || words.some((v) => !/^[a-fA-F0-9]{1,4}$/.test(v))) return;
    number = words.reduce((a, v) => (a << 16n) | BigInt(`0x${v}`), 0n);
  }
  const size = 1n << BigInt(family - mask),
    low = (number / size) * size;
  return { family, low, high: low + size - 1n };
}

export function addressInPrefix(address: string, prefix: string): boolean {
  if (!isIpLiteral(address)) return false;
  const canonical = address.includes(':')
    ? new URL(`http://[${address}]/`).hostname.slice(1, -1)
    : address;
  const ip = subnet(canonical),
    range = subnet(prefix);
  return (
    !!ip && !!range && ip.family === range.family && ip.low >= range.low && ip.high <= range.high
  );
}
export function prefixesOverlap(first: string, second: string): boolean {
  const a = subnet(first),
    b = subnet(second);
  return !!a && !!b && a.family === b.family && a.low <= b.high && b.low <= a.high;
}
export function isLoopbackAddress(address: string): boolean {
  return (
    address.toLowerCase() === 'localhost' ||
    ['127.0.0.0/8', '::1/128', '::ffff:7f00:0/104'].some((prefix) =>
      addressInPrefix(address, prefix),
    )
  );
}

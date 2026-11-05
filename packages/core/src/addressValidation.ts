// Leaf validators shared by node schemas, protocol forms and graph compilers.
export function isIpLiteral(address: string): boolean {
  if (address.includes(':')) {
    if (/[\s[\]%]/.test(address)) return false;
    try {
      return new URL(`http://[${address}]/`).hostname.startsWith('[');
    } catch {
      return false;
    }
  }
  const parts = address.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  );
}
export function ipProblem(value: string): boolean {
  const item = value.replace(/^!+/, '');
  if (/^(geoip:|ext:|ext-ip:)[^\s]+$/.test(item)) return false;
  const [address, prefix, ...extra] = item.split('/');
  return (
    !isIpLiteral(address) ||
    extra.length > 0 ||
    (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) > (address.includes(':') ? 128 : 32)))
  );
}
export function domainProblem(value: string): string | null {
  if (/^regexp:/.test(value)) {
    if (!value.slice(7)) return 'A regular expression cannot be empty.';
    return null;
  } // Go RE2 is validated by the core later, not JavaScript's different regex engine.
  if (
    /^(domain:|full:|keyword:|geosite:|dotless:)/.test(value) &&
    !value.slice(value.indexOf(':') + 1)
  )
    return 'A domain condition cannot be empty.';
  if (/\s/.test(value)) return 'Use one domain condition per line without spaces.';
  return null;
}
export const dnsIpLiteral = isIpLiteral;
export function dnsAddressProblem(address: string): string | null {
  if (dnsIpLiteral(address) || address === 'localhost') return null;
  try {
    const url = new URL(address);
    if (
      !['tcp:', 'tcp+local:', 'https:', 'https+local:', 'quic+local:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    if (
      (url.protocol.startsWith('tcp') || url.protocol === 'quic+local:') &&
      ((url.pathname && url.pathname !== '/') || url.search)
    )
      throw new Error();
    return null;
  } catch {
    return 'Use a UDP IP, tcp://host:port, https://host/dns-query, localhost, or a supported +local URL.';
  }
}

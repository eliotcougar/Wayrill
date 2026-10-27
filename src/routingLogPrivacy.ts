/** Runtime collection stays intact; sanitize deliberate bulk-copy and export only. */
export function maskLogDestination(destination: string, mask: string): string {
  if (!mask) return destination;
  const endpoint = /^(\[[^\]]+\]|[^:]+)(:\d+)?$/.exec(destination);
  if (!endpoint) return '[masked destination]';
  const [, host, port = ''] = endpoint;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const keep = mask === 'quarter' ? 1 : mask === 'half' ? 2 : 0;
    return (
      host
        .split('.')
        .map((part, index) => (index < keep ? part : '*'))
        .join('.') + port
    );
  }
  if (host.startsWith('[')) {
    if (mask === 'full') return `[masked IPv6]${port}`;
    try {
      const canonical = new URL(`http://${host}`).hostname.slice(1, -1);
      const [left, right] = canonical.split('::');
      const leading = left ? left.split(':') : [];
      const trailing = right ? right.split(':') : [];
      const groups =
        right === undefined
          ? leading
          : [
              ...leading,
              ...Array<string>(8 - leading.length - trailing.length).fill('0'),
              ...trailing,
            ];
      const keep = mask === 'quarter' ? 1 : 2;
      return `[${groups
        .slice(0, keep)
        .map((group) => Number.parseInt(group, 16).toString(16))
        .join(':')}::/${keep * 16}]${port}`;
    } catch {
      return `[masked IPv6]${port}`;
    }
  }
  return `[masked domain]${port}`;
}

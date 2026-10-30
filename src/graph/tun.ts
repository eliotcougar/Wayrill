/** App presets, independent of the embedded core defaults. */
export const DEFAULT_TUN_ADAPTER_NAME = 'Wayrill-TUN';
export const DEFAULT_ICS_ADAPTER_NAME = 'Wayrill-ICS';
export const DEFAULT_ICS_GATEWAY = '10.91.0.1/32';
export const NAT_ROUTING_TAG = 'wr-n';
export const isTunKind = (kind: string) => kind === 'tun-inbound' || kind === 'ics-tun';
export function tunAdapterNameProblem(name: unknown): string | undefined {
  if (name === undefined || name === '') return undefined;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 100 ||
    /[\\/:*?"<>|]/.test(name) ||
    Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return 'Enter a valid adapter name (up to 100 characters).';
}
export const tunCaptureSettings = (ipv6: boolean) => ({
  name: DEFAULT_TUN_ADAPTER_NAME,
  gateway: ['10.90.0.1/24', ...(ipv6 ? ['fd90::1/64'] : [])],
  dns: ['1.1.1.1', '1.0.0.1'],
  mtu: 1500,
  autoSystemRoutingTable: ['0.0.0.0/1', '128.0.0.0/1', ...(ipv6 ? ['::/1', '8000::/1'] : [])],
  autoOutboundsInterface: 'auto',
});

/** Change capture scope without resetting unrelated adapter choices. */
export function tunCaptureScope(settings: Record<string, unknown>, ipv6: boolean) {
  const preset = tunCaptureSettings(ipv6);
  return {
    ...preset,
    ...settings,
    gateway: preset.gateway,
    autoSystemRoutingTable: preset.autoSystemRoutingTable,
  };
}

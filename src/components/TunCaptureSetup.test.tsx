// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { desktopServiceAvailable, serviceCall } from '../serviceClient';
import { tunCaptureSettings } from '../graph/tun';
import TunCaptureSetup from './TunCaptureSetup';

vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: vi.fn(() => true),
  serviceCall: vi.fn(),
  errorText: (error: unknown) => String(error),
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(desktopServiceAvailable).mockReturnValue(true);
  vi.mocked(serviceCall).mockResolvedValue([
    { name: 'Ethernet', active: true },
    { name: 'Unused', active: false },
  ]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((button) => button.textContent === text)!;
it('capture presets retain the chosen uplink, resolver, name, MTU and advanced settings', async () => {
  const onChange = vi.fn(),
    settings = {
      ...tunCaptureSettings(true),
      name: 'Work',
      mtu: 1400,
      dns: ['192.0.2.53'],
      autoOutboundsInterface: 'Ethernet',
      autoSystemWfpBlockLeak: ['dns'],
    };
  await act(async () => root.render(<TunCaptureSetup settings={settings} onChange={onChange} />));
  await act(async () => button('Capture IPv4 only').click());
  expect(onChange).toHaveBeenCalledWith({
    ...settings,
    gateway: ['10.90.0.1/24'],
    autoSystemRoutingTable: ['0.0.0.0/1', '128.0.0.0/1'],
  });
});
it('can retry a failed inventory without losing the configured adapter', async () => {
  vi.mocked(serviceCall).mockRejectedValueOnce(new Error('Service unavailable'));
  await act(async () =>
    root.render(
      <TunCaptureSetup
        settings={{ autoOutboundsInterface: 'Configured VPN' }}
        onChange={vi.fn()}
      />,
    ),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Service unavailable');
  expect(host.querySelector('select')?.value).toBe('Configured VPN');
  await act(async () => button('Refresh adapters').click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(serviceCall).toHaveBeenCalledTimes(2);
});

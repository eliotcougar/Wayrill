// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import OutboundTestSettings from './OutboundTestSettings';
import { defaultTestSettings } from '../outboundTestSettings';
import { udpUrlSuggestions } from '../testUrlSuggestions';
import UdpTestBadge from './UdpTestBadge';
vi.mock('./useModalDialog', () => ({ default: () => {} }));

it('enables an unfiltered editable UDP destination and saves the checkbox and manual value', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.showPopover = function () {};
  HTMLElement.prototype.hidePopover = function () {};
  HTMLElement.prototype.scrollIntoView = function () {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    save = vi.fn(),
    close = vi.fn();
  try {
    await act(() =>
      root.render(
        <OutboundTestSettings
          settings={{ value: { ...defaultTestSettings }, save }}
          onClose={close}
        />,
      ),
    );
    const input = host.querySelector<HTMLInputElement>('#outbound-udp-url')!;
    expect(input.disabled).toBe(true);
    await act(() => host.querySelector<HTMLInputElement>('[type=checkbox]')!.click());
    expect(input.disabled).toBe(false);
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'stun://probe.example:4444',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => input.parentElement!.querySelector<HTMLButtonElement>('button')!.click());
    const options = [...input.parentElement!.querySelectorAll('[role=option]')].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(udpUrlSuggestions);
    await act(() =>
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ udpEnabled: true, udpUrl: 'stun://probe.example:4444' }),
    );
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

it('shows UDP only for completed tests and distinguishes failure without relying on color', async () => {
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(() => root.render(<UdpTestBadge />));
    expect(host.textContent).toBe('');
    await act(() =>
      root.render(<UdpTestBadge result={{ reachable: false, title: 'Timed out' }} />),
    );
    expect(
      host.querySelector('[aria-label="UDP unavailable"]')?.classList.contains('unreachable'),
    ).toBe(true);
    expect(host.querySelector('span')?.title).toBe('Timed out');
    await act(() =>
      root.render(<UdpTestBadge result={{ reachable: true, title: 'Reply received' }} />),
    );
    expect(
      host.querySelector('[aria-label="UDP available"]')?.classList.contains('reachable'),
    ).toBe(true);
  } finally {
    await act(() => root.unmount());
  }
});

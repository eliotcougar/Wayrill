// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import UdpTestBadge from './UdpTestBadge';
vi.mock('./useModalDialog', () => ({ default: () => {} }));

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

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WindowsCaptureSettings from './WindowsCaptureSettings';
import { serviceCall } from '../serviceClient';
import { defaultCaptureOptions } from '../graph/capture';
import type { GraphState } from '../graph/types';
vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  errorText: String,
  serviceCall: vi.fn(),
}));
let root: Root, host: HTMLDivElement;
const snapshot = {
  version: 'first',
  unmatched: ['preserved-sid'],
  packages: [
    { family: 'one', name: 'One app', publisher: 'QA', enabled: false },
    { family: 'two', name: 'Two app', publisher: 'QA', enabled: true },
  ],
};
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  vi.mocked(serviceCall).mockImplementation(async (method) =>
    method === 'windows.catalog'
      ? {
          packages: [],
          services: [],
          processes: [],
          interfaces: [
            { id: 'old', name: 'Old LAN', description: 'Old', status: 1 },
            { id: 'new', name: 'New LAN', description: 'New', status: 1 },
          ],
          captureInterfaces: [{ id: 'old', name: 'Old LAN', monitored: true }],
        }
      : structuredClone(snapshot),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const graph = (): GraphState => ({
  name: 'QA',
  nodes: [],
  edges: [],
  captureOptions: defaultCaptureOptions(),
});
it('applies only changed visible permissions with the complete-list version', async () => {
  await act(async () =>
    root.render(<WindowsCaptureSettings graph={graph()} onApply={vi.fn()} onClose={vi.fn()} />),
  );
  await act(async () => button('Loopback exemptions').click());
  const search = host.querySelector<HTMLInputElement>(
    'input[aria-label="Search loopback packages"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'One');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Enable visible').click());
  await act(async () => button('Apply permissions (1)').click());
  expect(serviceCall).toHaveBeenCalledWith('windows.loopback.set', {
    expectedVersion: 'first',
    changes: [{ family: 'one', enabled: true }],
  });
  expect(host.textContent).toContain('1 unmatched exemptions');
});

it('makes retained host and ICS TUN unselectable and clears stale monitored selections', async () => {
  const own = '11111111-1111-1111-1111-111111111111';
  const shared = '22222222-2222-2222-2222-222222222222';
  vi.mocked(serviceCall).mockResolvedValue({
    ownerSid: 'owner',
    packages: [],
    services: [],
    processes: [],
    interfaces: [
      {
        id: `{${own}}`,
        name: 'Host TUN',
        description: 'Wintun',
        status: 1,
        captureExcluded: true,
        addresses: [{ address: '10.90.0.1', prefixLength: 24 }],
      },
      { id: shared, name: 'ICS TUN', description: 'Wintun', status: 2, captureExcluded: true },
      {
        id: 'foreign',
        name: 'Other VPN',
        description: 'Wintun',
        status: 1,
        addresses: [{ address: '10.8.0.1', prefixLength: 24 }],
      },
    ],
    excludedCaptureInterfaces: [own, shared],
  });
  const draft = graph(),
    apply = vi.fn();
  draft.captureOptions!.interfaces.interfaces = [
    { id: own, name: 'Host TUN', monitored: true },
    { id: shared, name: 'ICS TUN', monitored: true },
  ];
  await act(async () =>
    root.render(<WindowsCaptureSettings graph={draft} onApply={apply} onClose={vi.fn()} />),
  );
  const checkbox = (name: string) =>
    [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.includes(name))!
      .querySelector<HTMLInputElement>('input')!;
  for (const name of ['Host TUN', 'ICS TUN']) {
    expect(checkbox(name).disabled).toBe(true);
    expect(checkbox(name).checked).toBe(false);
  }
  expect(checkbox('Other VPN').disabled).toBe(false);
  await act(async () => button('Apply to graph').click());
  expect(
    apply.mock.calls[0][0].captureOptions.interfaces.interfaces
      .filter((a: { id: string; monitored: boolean }) => a.id !== 'foreign')
      .every((a: { monitored: boolean }) => !a.monitored),
  ).toBe(true);
  await act(async () => button('Select active adapters').click());
  expect(checkbox('Host TUN').checked).toBe(false);
  expect(checkbox('ICS TUN').checked).toBe(false);
  expect(checkbox('Other VPN').checked).toBe(true);
  expect(draft.captureOptions!.interfaces.interfaces[0].monitored).toBe(true);
});

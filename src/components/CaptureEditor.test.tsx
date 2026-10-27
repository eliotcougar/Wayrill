// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CaptureEditor from './CaptureEditor';
import { makeNode } from '../graph/catalog';
import { serviceCall } from '../serviceClient';

vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  errorText: String,
  serviceCall: vi.fn(async () => ({
    ownerSid: 'owner',
    interfaces: [],
    processes: [],
    packages: [],
    services: [
      { name: 'Dnscache', displayName: 'DNS Client', pid: 1 },
      { name: 'Other', displayName: 'Other service', pid: 2 },
    ],
  })),
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it('edits monitored adapters without process filters or loopback permissions', async () => {
  const node = makeNode('windivert-inbound', { x: 0, y: 0 }, 'capture');
  const graph = { name: 'Adapter QA', nodes: [node], edges: [] };
  const apply = vi.fn();
  await act(async () =>
    root.render(<CaptureEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  expect(host.textContent).toContain('Monitored adapters');
  expect(host.querySelector('select')).toBeNull();
  expect(host.textContent).not.toContain('Traffic selection');
  expect(host.textContent).not.toContain('Loopback exemptions');
  const check = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => check.click());
  const save = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Apply to graph'),
  )!;
  await act(async () => save.click());
  expect(apply.mock.calls[0][0].captureOptions.interfaces.monitorNewInterfaces).toBe(false);
  expect(graph).not.toHaveProperty('captureOptions');
  expect(vi.mocked(serviceCall).mock.calls.every((c) => c[0] === 'windows.catalog')).toBe(true);
});

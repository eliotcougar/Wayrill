// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RoutingDiagnostics from './RoutingDiagnostics';
import { serviceCall } from '../serviceClient';
import type { RuntimeController } from '../useRuntime';
import type { GraphState } from '../graph/types';
import type { DiagnosticConfiguration } from '../routingDiagnostics';
vi.mock('../serviceClient', () => ({
  serviceCall: vi.fn(),
  errorText: (error: unknown) => String(error),
}));

const graph = { nodes: [], edges: [] } as unknown as GraphState;
const draft: DiagnosticConfiguration = {
  config: {
    inbounds: [{ tag: 'source' }],
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'dns', protocol: 'dns' },
    ],
    routing: { rules: [{ domain: ['domain:example.com'], outboundTag: 'direct' }] },
  },
  displayNames: { inbound: { source: 'Local proxy' }, outbound: { direct: 'Direct' } },
};
const runtime = {
  connected: true,
  capabilities: ['routing.diagnostics'],
  savedConfig: null,
  savedCapture: null,
  savedRevision: 0,
} as unknown as RuntimeController;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(serviceCall).mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const render = (plan = draft, controller = runtime) =>
  act(() =>
    root.render(
      <RoutingDiagnostics
        draft={plan}
        runtime={controller}
        graph={graph}
        onClose={() => {}}
        onIssue={() => {}}
      />,
    ),
  );
async function destination(value: string) {
  const input = host.querySelector<HTMLInputElement>('[placeholder="example.com"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

it('uses the selected draft and invalidates the result after editing the destination', async () => {
  vi.mocked(serviceCall).mockResolvedValue({
    job: 11,
    busy: false,
    result: { ruleIndex: 0, outboundTag: 'direct' },
    error: null,
    cancelled: false,
  });
  await render();
  await destination('example.com');
  await act(() => button('Evaluate route').click());
  expect(serviceCall).toHaveBeenCalledWith(
    'routing.diagnosticStart',
    expect.objectContaining({
      config: draft.config,
      route: expect.objectContaining({
        domain: 'example.com',
        inbound: 'source',
        network: 'tcp',
        port: 443,
      }),
    }),
  );
  expect(host.querySelector('[aria-label="Diagnostic result"]')?.textContent).toContain('Direct');
  await destination('another.example');
  expect(host.querySelector('[aria-label="Diagnostic result"]')).toBeNull();
  expect(
    vi.mocked(serviceCall).mock.calls.every(([method]) => method.startsWith('routing.diagnostic')),
  ).toBe(true);
});

it('cancels a start acknowledged after the dialog closes instead of leaving an orphan job', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(serviceCall).mockImplementation((method) =>
    method === 'routing.diagnosticStart'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : (Promise.resolve({}) as never),
  );
  await render();
  await destination('example.com');
  await act(() => button('Evaluate route').click());
  await act(() => root.render(null));
  await act(async () => {
    finish({ job: 42, busy: true, result: null, error: null, cancelled: false });
    await Promise.resolve();
  });
  expect(serviceCall).toHaveBeenCalledWith('routing.diagnosticCancel', { job: 42 });
});

it('remembers Cancel pressed before the service acknowledges the new job', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(serviceCall).mockImplementation((method) =>
    method === 'routing.diagnosticStart'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : (Promise.resolve({ job: 43, busy: false, cancelled: true }) as never),
  );
  await render();
  await destination('example.com');
  await act(() => button('Evaluate route').click());
  await act(() => button('Cancel test').click());
  await act(async () => {
    finish({ job: 43, busy: true, result: null, error: null, cancelled: false });
    await Promise.resolve();
  });
  expect(serviceCall).toHaveBeenCalledWith('routing.diagnosticCancel', { job: 43 });
});

it('does not bypass unavailable-service guards when Enter is pressed in the destination', async () => {
  await render(draft, { ...runtime, connected: false });
  await destination('example.com');
  await act(() => {
    host
      .querySelector('[placeholder="example.com"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(button('Evaluate route').disabled).toBe(true);
  expect(serviceCall).not.toHaveBeenCalled();
});

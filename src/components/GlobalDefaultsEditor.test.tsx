// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GlobalDefaultsEditor from './GlobalDefaultsEditor';
import { createPolicyExample } from '../graph/policyExample';
import { importXrayConfig } from '../graph/xrayImport';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

it('checks a large subscription in the background and ignores superseded results', async () => {
  vi.useFakeTimers();
  const messages: {
    id: number;
    graph: ReturnType<typeof createPolicyExample>;
    scope: string;
  }[] = [];
  const workers: WorkerMock[] = [];
  class WorkerMock {
    constructor() {
      workers.push(this);
    }
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    postMessage(message: (typeof messages)[number]) {
      messages.push(message);
    }
    terminate = vi.fn();
  }
  vi.stubGlobal('Worker', WorkerMock);
  try {
    const graph = importXrayConfig(
      JSON.stringify({
        outbounds: Array.from({ length: 502 }, (_, i) => ({
          tag: `entry-${i}`,
          protocol: 'freedom',
        })),
        routing: { balancers: [{ tag: 'pool', selector: ['entry-'] }] },
      }),
    );
    await act(() =>
      root.render(<GlobalDefaultsEditor graph={graph} onApply={vi.fn()} onClose={vi.fn()} />),
    );
    expect(host.textContent).toContain('Checking affected nodes');
    await act(() => vi.advanceTimersByTime(100));
    expect(messages).toHaveLength(1);
    expect(messages[0].scope).toBe('nodes');
    const oldReply = workers[0].onmessage!;
    const input = host.querySelector<HTMLInputElement>('#setting-global-inboundUserLevel')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '4');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => vi.advanceTimersByTime(100));
    expect(messages).toHaveLength(2);
    expect(workers).toHaveLength(2);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(messages[1].graph.defaults?.settings.inboundUserLevel).toBe(4);
    const respond = (reply: (event: MessageEvent) => void, id: number, message: string) =>
      reply(
        new MessageEvent('message', {
          data: {
            id,
            result: {
              issues: [{ severity: 'error', nodeId: graph.nodes[0].id, message }],
              compilation: null,
              configBytes: 0,
            },
          },
        }),
      );
    await act(() => respond(oldReply, messages[0].id, 'Old defaults issue'));
    expect(host.textContent).not.toContain('Old defaults issue');
    expect(host.textContent).toContain('Checking affected nodes');
    await act(() => respond(workers[1].onmessage!, messages[1].id, 'Current defaults issue'));
    expect(host.textContent).toContain('Current defaults issue');
    expect(host.textContent).not.toContain('Checking affected nodes');
    await act(() => root.render(null));
    expect(workers[1].terminate).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('replaces an invalid named policy draft when complete policy JSON is edited', async () => {
  const graph = createPolicyExample(),
    apply = vi.fn();
  graph.defaults!.settings.policy = '{"levels":{"0":{"handshake":60},"1":{"handshake":40}}}';
  await act(() =>
    root.render(
      <GlobalDefaultsEditor
        graph={graph}
        onApply={apply}
        onClose={vi.fn()}

        initialSection="core"
      />,
    ),
  );
  const change = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(() => {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const save = () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save defaults')!;
  await change(host.querySelector<HTMLInputElement>('#global-policy-level-0-handshake')!, '-1');
  expect(save().disabled).toBe(true);
  const replacement = '{"levels":{"0":{"handshake":60},"1":{"handshake":41}}}';
  await change(host.querySelector<HTMLTextAreaElement>('#setting-global-policy')!, replacement);
  expect(host.querySelector<HTMLInputElement>('#global-policy-level-0-handshake')!.value).toBe(
    '60',
  );
  expect(save().disabled).toBe(false);
  await act(() => save().click());
  expect(JSON.parse(apply.mock.calls[0][0].settings.policy)).toEqual(JSON.parse(replacement));
});

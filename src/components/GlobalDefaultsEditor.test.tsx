// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GlobalDefaultsEditor from './GlobalDefaultsEditor';
import { DiagnosticFocusContext } from './DiagnosticNavigation';
import { createPolicyExample } from '../graph/policyExample';
import { importXrayConfig } from '../graph/xrayImport';
import { defaultSections, globalFields, resetCoreDefault } from '../graph/defaults';

let root: Root, host: HTMLDivElement;
it.each([
  ['security', 'fingerprint', 'tlsMinVersion'],
  ['mux', 'muxEnabled', 'muxConcurrency'],
  ['fragment', 'fragmentEnabled', 'fragmentLengths'],
  ['connections', 'interface', 'tcpKeepAliveIdle'],
  ['transports', 'xhttpMode', 'grpcIdleTimeout'],
])('keeps common %s controls visible and tuning collapsed', async (section, main, advanced) => {
  await act(() =>
    root.render(
      <GlobalDefaultsEditor
        graph={createPolicyExample()}
        initialSection={section}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  const field = host.querySelector(`#setting-global-${main}`)!;
  expect(field).not.toBeNull();
  expect(field.closest('details')).toBeNull();
  const tuning = host.querySelector(`#setting-global-${advanced}`)!.closest('details')!;
  expect(tuning).not.toBeNull();
  expect(tuning.open).toBe(false);
  expect(host.querySelector('.defaults-dns-note')).toBeNull();
});
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
it('opens the category of a global diagnostic and focuses its inherited control', async () => {
  const graph = createPolicyExample(),
    field = globalFields.find((f) => f.key === 'muxConcurrency')!;
  await act(() =>
    root.render(
      <DiagnosticFocusContext.Provider
        value={{
          surface: 'defaults',
          issue: {
            severity: 'error',
            message: 'Localized',
            scope: 'defaults',
            fieldKey: field.key,
          },
        }}
      >
        <GlobalDefaultsEditor graph={graph} onApply={vi.fn()} onClose={vi.fn()} />
      </DiagnosticFocusContext.Provider>,
    ),
  );
  expect(document.activeElement!.id).toBe('setting-global-muxConcurrency');
  expect(
    host.querySelector('.defaults-navigation button[aria-pressed="true"]')!.textContent,
  ).toContain(defaultSections.find((s) => s.id === field.section)!.title);
});
it('retains an invalid global number across category and search changes until corrected', async () => {
  const graph = createPolicyExample(),
    apply = vi.fn();
  await act(() =>
    root.render(<GlobalDefaultsEditor graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const input = host.querySelector<HTMLInputElement>('#setting-global-inboundUserLevel')!;
  const enter = async (el: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await enter(input, '-1');
  const save = () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save defaults')!;
  expect(save().disabled).toBe(true);
  await act(() =>
    host.querySelectorAll<HTMLButtonElement>('.defaults-navigation button')[1].click(),
  );
  expect(save().disabled).toBe(true);
  expect(input.value).toBe('-1');
  await enter(
    host.querySelector<HTMLInputElement>('[aria-label="Search global defaults"]')!,
    'tls',
  );
  expect(save().disabled).toBe(true);
  await act(() => host.querySelector<HTMLButtonElement>('button.diagnostic')!.click());
  expect(document.activeElement).toBe(input);
  await enter(input, '1');
  expect(save().disabled).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
it('shows configured zero behavior and core provenance after per-field reset', async () => {
  const graph = createPolicyExample(),
    apply = vi.fn();
  await act(() =>
    root.render(<GlobalDefaultsEditor graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const search = host.querySelector<HTMLInputElement>('[aria-label="Search global defaults"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      search,
      'tcpKeepAliveIdle',
    );
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const input = host.querySelector<HTMLInputElement>('#setting-global-tcpKeepAliveIdle')!,
    option = input.closest('.default-option')!;
  expect(input.value).toBe('0');
  expect(option.textContent).toContain('App setting');
  expect(option.textContent).toContain('Effective · 0 → 45 seconds for outbound TCP');
  await act(() =>
    option
      .querySelector<HTMLButtonElement>(
        '[aria-label="Use Xray default for TCP keepalive idle (seconds)"]',
      )!
      .click(),
  );
  expect(input.value).toBe('');
  expect(option.querySelector('.inherited-badge')!.textContent).toBe('Xray default');
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save defaults')!.click(),
  );
  expect(apply.mock.calls[0][0].settings).not.toHaveProperty('tcpKeepAliveIdle');
});
it('retains configured false and keeps a missing boolean distinct from false', async () => {
  const graph = createPolicyExample();
  graph.defaults = resetCoreDefault(graph.defaults!, 'sniffing');
  const apply = vi.fn();
  await act(() =>
    root.render(<GlobalDefaultsEditor graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const select = host.querySelector<HTMLSelectElement>('#setting-global-sniffing')!,
    option = select.closest('.default-option')!;
  expect(select.value).toBe('__wayrill_inherit__');
  await act(() => {
    select.value = 'false';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(select.value).toBe('false');
  expect(option.querySelector('.override-badge')!.textContent).toBe('App setting');
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save defaults')!.click(),
  );
  expect(apply.mock.calls[0][0].settings.sniffing).toBe(false);
});
it('does not commit bulk reset on Cancel', async () => {
  const graph = createPolicyExample(),
    original = structuredClone(graph.defaults),
    apply = vi.fn(),
    close = vi.fn();
  await act(() =>
    root.render(<GlobalDefaultsEditor graph={graph} onApply={apply} onClose={close} />),
  );
  await act(() =>
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Use all Xray defaults')!
      .click(),
  );
  expect(host.querySelector('.rule-editor-footer')!.textContent).toContain('node(s) affected');
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click(),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(graph.defaults).toEqual(original);
});

it('retains an edited default while searching after removing the applicability disclosure', async () => {
  const graph = createPolicyExample(),
    apply = vi.fn();
  await act(() =>
    root.render(<GlobalDefaultsEditor graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const udp = host.querySelector<HTMLSelectElement>('#setting-global-udp')!;
  await act(() => {
    udp.value = 'false';
    udp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector('.defaults-applicability')).toBeNull();
  const search = host.querySelector<HTMLInputElement>('[aria-label="Search global defaults"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      search,
      'Enable SOCKS5 UDP',
    );
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(udp.value).toBe('false');
  expect(apply).not.toHaveBeenCalled();
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save defaults')!.click(),
  );
  expect(apply.mock.calls[0][0].settings.udp).toBe(false);
});

it('opens shared resources directly, stages changes, and cancels without changing defaults', async () => {
  const graph = createPolicyExample(),
    apply = vi.fn(),
    close = vi.fn();
  await act(() =>
    root.render(
      <GlobalDefaultsEditor
        initialSection="resources"
        graph={graph}
        onApply={apply}
        onClose={close}
      />,
    ),
  );
  await act(() =>
    host.querySelector<HTMLButtonElement>('[aria-label="Default ru-geosite.dat"]')!.click(),
  );
  expect(
    host.querySelector('[aria-label="Default geosite.dat"]')!.getAttribute('aria-pressed'),
  ).toBe('false');
  expect(
    host.querySelector('[aria-label="Default ru-geosite.dat"]')!.getAttribute('aria-pressed'),
  ).toBe('true');
  expect(graph.defaults?.resources).toBeUndefined();
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click(),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});
it('saves resource defaults atomically and rejects an invalid update period', async () => {
  const graph = createPolicyExample(),
    apply = vi.fn();
  await act(() =>
    root.render(
      <GlobalDefaultsEditor
        initialSection="resources"
        graph={graph}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(() =>
    host.querySelector<HTMLButtonElement>('[aria-label="Edit geosite.dat"]')!.click(),
  );
  const input = host.querySelector<HTMLInputElement>('.resource-file-dialog input[type="number"]')!;
  const enter = async (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const saveFile = () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save file')!;
  await enter('0');
  await act(() => saveFile().click());
  expect(host.querySelector('.resource-file-dialog [role="alert"]')?.textContent).toContain(
    'update period',
  );
  expect(apply).not.toHaveBeenCalled();
  await enter('48');
  await act(() => saveFile().click());
  expect(host.querySelector('.resource-file-dialog')).toBeNull();
  expect(apply).not.toHaveBeenCalled();
  await act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save defaults')!
      .click(),
  );
  expect(
    apply.mock.calls[0][0].resources.files.find(
      (file: { name: string }) => file.name === 'geosite.dat',
    ).intervalHours,
  ).toBe(48);
});
it('adds extra files with URL and disk controls in one editor and stages them until defaults are saved', async () => {
  const apply = vi.fn();
  await act(() =>
    root.render(
      <GlobalDefaultsEditor
        initialSection="resources"
        graph={createPolicyExample()}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(() =>
    host.querySelector<HTMLButtonElement>('[aria-label="Add GeoSite file"]')!.click(),
  );
  expect(
    host.querySelector<HTMLInputElement>('.resource-file-dialog [role="combobox"]')!.type,
  ).toBe('url');
  expect(host.querySelector('.resource-file-dialog [aria-label="Choose DAT file"]')).not.toBeNull();
  await act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save file')!
      .click(),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(host.querySelectorAll('.resource-table tbody tr')).toHaveLength(9);
  await act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save defaults')!
      .click(),
  );
  expect(apply.mock.calls[0][0].resources.files).toHaveLength(9);
});

it('blocks invalid default list entries and recovers when corrected', async () => {
  const graph = createPolicyExample(),
    apply = vi.fn();
  await act(() =>
    root.render(<GlobalDefaultsEditor graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const input = host.querySelector<HTMLTextAreaElement>('#setting-global-domainsExcluded')!;
  const write = async (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await write('[1]');
  let save = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Save defaults',
  )!;
  expect(save.disabled).toBe(true);
  expect(host.textContent).toContain('array of nonempty rule strings');
  await write('[]');
  save = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Save defaults',
  )!;
  expect(save.disabled).toBe(false);
  await act(() => save.click());
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0][0].settings.domainsExcluded).toBe('[]');
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

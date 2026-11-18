// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeNode } from '../graph/catalog';
import { importXrayConfig } from '../graph/xrayImport';
import CoreOptionsEditor from './CoreOptionsEditor';
import NativeDnsEditor from './NativeDnsEditor';

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

const editorButton = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!;
const fillDraft = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
it.each(['dns', 'policy'] as const)(
  '%s entry navigation preserves invalid drafts and valid JSON deliberately replaces them',
  async (family) => {
    const graph = importXrayConfig(
      JSON.stringify({ outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }] }),
    );
    const node = makeNode(family === 'dns' ? 'xray-dns-servers' : 'xray-options', { x: 0, y: 0 });
    node.data.settings.json = JSON.stringify(
      family === 'dns'
        ? {
            servers: [
              { address: '1.1.1.1', timeoutMs: 1000 },
              { address: '9.9.9.9', timeoutMs: 1000 },
            ],
          }
        : { policy: { levels: { '0': { handshake: 60 }, '1': { handshake: 60 } } } },
    );
    graph.nodes.push(node);
    const apply = vi.fn();
    await act(() =>
      root.render(
        family === 'dns' ? (
          <NativeDnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />
        ) : (
          <CoreOptionsEditor node={node} onApply={apply} onClose={vi.fn()} />
        ),
      ),
    );
    if (family === 'policy') await act(() => editorButton('Policy levels').click());
    const fieldId = family === 'dns' ? '#resolver-0-timeoutMs' : '#native-policy-level-0-handshake';
    await fillDraft(host.querySelector<HTMLInputElement>(fieldId)!, '-1');
    const picker = host.querySelector<HTMLSelectElement>(
      family === 'dns'
        ? '[aria-label="Server entry"]'
        : '[aria-label="native-policy policy level"]',
    )!;
    expect(picker.disabled).toBe(true);
    const applyName = family === 'dns' ? 'Apply DNS settings' : 'Apply core settings';
    expect(editorButton(applyName).disabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    await act(() => editorButton('Native JSON').click());
    const raw = [...host.querySelectorAll<HTMLTextAreaElement>('textarea')].find(
      (t) =>
        t.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby') ===
        [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Native JSON')?.id,
    )!;
    const value = JSON.parse(raw.value);
    if (family === 'dns') value.servers[0].address = '8.8.8.8';
    else value.policy.levels['1'].handshake = 30;
    await fillDraft(raw, JSON.stringify(value));
    await act(() => editorButton(family === 'dns' ? 'Settings' : 'Policy levels').click());
    expect(host.querySelector<HTMLInputElement>(fieldId)!.value).toBe(
      family === 'dns' ? '1000' : '60',
    );
    expect(editorButton(applyName).disabled).toBe(false);
    await act(() => editorButton(applyName).click());
    expect(JSON.parse(apply.mock.calls[0][1].settings.json)).toEqual(value);
  },
);

it('edits native DNS server strings through the real form and converts them only for extra options', async () => {
  const graph = importXrayConfig(
    JSON.stringify({
      dns: { servers: ['1.1.1.1'] },
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    }),
  );
  const node = graph.nodes.find((n) => n.data.kind === 'xray-dns-servers')!,
    apply = vi.fn();
  await act(() =>
    root.render(<NativeDnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  await fillDraft(host.querySelector<HTMLInputElement>('#resolver-0-address')!, '1.0.0.1');
  await act(() => editorButton('Apply DNS settings').click());
  expect(JSON.parse(apply.mock.calls[0][1].settings.json).servers).toEqual(['1.0.0.1']);
  await act(() => {
    const field = host.querySelector<HTMLSelectElement>('#resolver-0-finalQuery')!;
    field.value = 'false';
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(() => editorButton('Apply DNS settings').click());
  expect(JSON.parse(apply.mock.calls[1][1].settings.json).servers).toEqual([
    { address: '1.0.0.1', finalQuery: false },
  ]);
});

it('retains hidden imported DNS query and metrics tags during ordinary form edits', async () => {
  const graph = importXrayConfig(
    JSON.stringify({
      dns: {
        tag: 'custom-query-source',
        servers: [{ address: '1.1.1.1', tag: 'custom-server-source' }],
      },
      metrics: { tag: 'custom-metrics', listen: '127.0.0.1:18590' },
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    }),
  );
  const apply = vi.fn();
  const servers = graph.nodes.find((node) => node.data.kind === 'xray-dns-servers')!;
  await act(() =>
    root.render(<NativeDnsEditor node={servers} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  expect(host.querySelector('#resolver-0-tag')).toBeNull();
  await fillDraft(host.querySelector<HTMLInputElement>('#resolver-0-address')!, '8.8.8.8');
  await act(() => editorButton('Apply DNS settings').click());
  expect(JSON.parse(apply.mock.calls[0][1].settings.json).servers).toEqual([
    { address: '8.8.8.8', tag: 'custom-server-source' },
  ]);
  const handler = graph.nodes.find((node) => node.data.kind === 'xray-dns')!;
  await act(() =>
    root.render(
      <NativeDnsEditor
        key="handler"
        node={handler}
        graph={graph}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(host.querySelector('#native-dns-tag')).toBeNull();
  await fillDraft(host.querySelector<HTMLInputElement>('#native-dns-clientIp')!, '192.0.2.1');
  await act(() => editorButton('Apply DNS settings').click());
  expect(JSON.parse(apply.mock.calls[1][1].settings.json)).toMatchObject({
    tag: 'custom-query-source',
    clientIp: '192.0.2.1',
  });
  const options = graph.nodes.find((node) => node.data.kind === 'xray-options')!;
  await act(() =>
    root.render(<CoreOptionsEditor node={options} onApply={apply} onClose={vi.fn()} />),
  );
  await act(() => editorButton('Statistics & metrics').click());
  expect(host.querySelector('#native-metrics-tag')).toBeNull();
  await fillDraft(
    host.querySelector<HTMLInputElement>('#native-metrics-listen')!,
    '127.0.0.1:18591',
  );
  await act(() => editorButton('Apply core settings').click());
  expect(JSON.parse(apply.mock.calls[2][1].settings.json).metrics).toEqual({
    tag: 'custom-metrics',
    listen: '127.0.0.1:18591',
  });
});

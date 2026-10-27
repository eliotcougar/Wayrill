// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeNode } from '../graph/catalog';
import { importXrayConfig } from '../graph/xrayImport';
import type { NodeKind } from '../graph/types';
import ProtocolEditor from './ProtocolEditor';
import CoreOptionsEditor from './CoreOptionsEditor';
import NativeDnsEditor from './NativeDnsEditor';
import FakeDnsEditor from './FakeDnsEditor';

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

it.each<NodeKind>([
  'trojan-outbound',
  'vless-inbound',
  'loopback-outbound',
  'xray-options',
  'xray-dns',
  'xray-dns-servers',
  'fakedns',
])(
  '%s exposes associated panes, manual keyboard activation and retained JSON drafts',
  async (kind) => {
    const graph = importXrayConfig(
      JSON.stringify({ outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }] }),
    );
    const node = makeNode(kind, { x: 0, y: 0 }),
      apply = vi.fn(),
      close = vi.fn();
    graph.nodes.push(node);
    const props = { node, onApply: apply, onClose: close };
    await act(() =>
      root.render(
        kind === 'xray-options' ? (
          <CoreOptionsEditor {...props} />
        ) : kind === 'fakedns' ? (
          <FakeDnsEditor {...props} graph={graph} />
        ) : kind.startsWith('xray-dns') ? (
          <NativeDnsEditor {...props} graph={graph} />
        ) : (
          <ProtocolEditor {...props} defaults={graph.defaults} />
        ),
      ),
    );
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.length).toBeGreaterThan(1);
    for (const pane of host.querySelectorAll('[role="tabpanel"]')) {
      expect(document.getElementById(pane.getAttribute('aria-labelledby')!)).not.toBeNull();
    }
    for (const tab of tabs) {
      const pane = document.getElementById(tab.getAttribute('aria-controls')!)!;
      expect(pane.getAttribute('role')).toBe('tabpanel');
      expect(pane.getAttribute('aria-labelledby')).toBe(tab.id);
      expect(pane.hidden).toBe(tab.getAttribute('aria-selected') !== 'true');
    }
    const key = async (key: string) =>
      act(() =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        ),
      );
    await act(() => tabs[0].focus());
    await key('ArrowRight');
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    await key(' ');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    const json = tabs.find((t) => t.textContent === 'Native JSON')!;
    await act(() => json.click());
    const pane = document.getElementById(json.getAttribute('aria-controls')!)!;
    const field = pane.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field,
        '{ unfinished',
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => tabs[0].click());
    await act(() => json.click());
    expect(pane.querySelector('textarea')).toBe(field);
    expect(field.value).toBe('{ unfinished');
    await act(() =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click(),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  },
);

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

it('shows root DNS defaults and server inheritance with distinct field metadata', async () => {
  const graph = importXrayConfig(
    JSON.stringify({
      dns: { queryStrategy: 'UseIPv4', disableCache: true, servers: ['https://1.1.1.1/dns-query'] },
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    }),
  );
  const handler = graph.nodes.find((n) => n.data.kind === 'xray-dns')!;
  await act(() =>
    root.render(
      <NativeDnsEditor node={handler} graph={graph} onApply={vi.fn()} onClose={vi.fn()} />,
    ),
  );
  const option = (id: string) => host.querySelector<HTMLSelectElement>('#' + id)!.options[0].text;
  expect(option('native-dns-queryStrategy')).toBe('Default: UseIP — IPv4 and IPv6');
  expect(option('native-dns-disableCache')).toBe('Default: Disabled');
  expect(host.querySelector<HTMLInputElement>('#native-dns-clientIp')!.placeholder).toBe(
    'No EDNS client IP',
  );
  expect(host.querySelector<HTMLInputElement>('#native-dns-serveExpiredTTL')!.placeholder).toBe(
    '0 seconds',
  );
  const server = graph.nodes.find((n) => n.data.kind === 'xray-dns-servers')!;
  await act(() =>
    root.render(
      <NativeDnsEditor
        key="server"
        node={server}
        graph={graph}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(option('resolver-0-queryStrategy')).toBe('Default: UseIPv4');
  expect(option('resolver-0-disableCache')).toBe('Default: Enabled');
});

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

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { importXrayConfig } from '../graph/xrayImport';
import { compileXrayGraph } from '../graph/xrayCompiler';
import ProtocolEditor from './ProtocolEditor';

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
const fixture = () => ({
  outbounds: [
    {
      tag: 'out',
      protocol: 'trojan',
      settings: { servers: [{ address: 'public.example', port: 443, password: 'public-fixture' }] },
      streamSettings: {
        network: 'raw',
        security: 'tls',
        tlsSettings: { serverName: 'public.example' },
      },
    },
  ],
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const setup = async () => {
  const original = fixture(),
    graph = importXrayConfig(JSON.stringify(original)),
    node = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!,
    apply = vi.fn((_: string, data) => {
      node.data = { ...node.data, ...data };
    }),
    close = vi.fn();
  await act(() =>
    root.render(
      <ProtocolEditor node={node} defaults={graph.defaults} onApply={apply} onClose={close} />,
    ),
  );
  await act(() => button('Global defaults').click());
  return { original, graph, node, apply, close };
};
it('does not present imported omissions as app placeholders, and Apply without edits preserves every JSON value', async () => {
  const { original, graph } = await setup();
  expect(host.querySelector<HTMLInputElement>('#protocol-default-tcpKeepAliveIdle')!.value).toBe(
    '',
  );
  expect(
    host.querySelector<HTMLInputElement>('#protocol-default-tcpKeepAliveIdle')!.placeholder,
  ).toBe('45 seconds for outbound TCP');
  expect(host.querySelector<HTMLSelectElement>('#protocol-default-fingerprint')!.value).toBe(
    '__wayrill_omitted__',
  );
  expect(host.textContent).toContain('Imported omission');
  await act(() => button('Apply protocol settings').click());
  expect(compileXrayGraph(graph).config).toEqual(original);
});
const enter = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
it('keeps the latest edit when named and native values are changed in either order', async () => {
  const { graph } = await setup();
  await enter(host.querySelector<HTMLInputElement>('#protocol-default-tcpKeepAliveIdle')!, '0');
  await act(() => button('Native JSON').click());
  const raw = host.querySelector<HTMLTextAreaElement>('textarea[data-diagnostic-field="json"]')!,
    value = JSON.parse(raw.value);
  value.streamSettings.sockopt.tcpKeepAliveIdle = 12;
  await enter(raw, JSON.stringify(value));
  await act(() => button('Global defaults').click());
  expect(host.querySelector<HTMLInputElement>('#protocol-default-tcpKeepAliveIdle')!.value).toBe(
    '12',
  );
  await enter(host.querySelector<HTMLInputElement>('#protocol-default-tcpKeepAliveIdle')!, '13');
  await act(() => button('Apply protocol settings').click());
  expect(
    (compileXrayGraph(graph).config.outbounds as any[])[0].streamSettings.sockopt.tcpKeepAliveIdle,
  ).toBe(13);
});

it('retains invalid collection input until corrected and prevents entry navigation from discarding it', async () => {
  const original = {
    inbounds: [
      {
        tag: 'in',
        protocol: 'vmess',
        listen: '127.0.0.1',
        port: 2082,
        settings: {
          clients: [
            {
              id: '11111111-2222-4333-8444-555555555555',
              level: 0,
              email: 'first@example.invalid',
            },
            {
              id: '21111111-2222-4333-8444-555555555555',
              level: 0,
              email: 'second@example.invalid',
            },
          ],
        },
      },
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
  };
  const graph = importXrayConfig(JSON.stringify(original));
  const node = graph.nodes.find((n) => n.data.kind === 'vmess-inbound')!;
  const apply = vi.fn((_: string, data) => {
    node.data = { ...node.data, ...data };
  });
  await act(() =>
    root.render(
      <ProtocolEditor node={node} defaults={graph.defaults} onApply={apply} onClose={vi.fn()} />,
    ),
  );
  const level = host.querySelector<HTMLInputElement>('#protocol-settings-clients-0-level')!;
  await enter(level, '-1');
  expect(button('Apply protocol settings').disabled).toBe(true);
  const picker = host.querySelector<HTMLSelectElement>('[aria-label="Clients entry"]')!;
  expect(picker.disabled).toBe(true);
  expect(button('Add clients').disabled).toBe(true);
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Move Clients entry down"]')!.disabled,
  ).toBe(true);
  expect(level.value).toBe('-1');
  expect(apply).not.toHaveBeenCalled();
  await enter(level, '3');
  expect(picker.disabled).toBe(false);
  await act(() => {
    picker.value = '1';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector<HTMLInputElement>('#protocol-settings-clients-1-level')!.value).toBe(
    '0',
  );
  await act(() => button('Apply protocol settings').click());
  expect((compileXrayGraph(graph).config.inbounds as any[])[0].settings.clients).toEqual([
    { ...original.inbounds[0].settings.clients[0], level: 3 },
    original.inbounds[0].settings.clients[1],
  ]);
});

const collectionConfig = () => ({
  inbounds: [
    {
      tag: 'in',
      protocol: 'vmess',
      listen: '127.0.0.1',
      port: 2082,
      settings: {
        clients: [
          { id: '11111111-2222-4333-8444-555555555555', level: 0, email: 'first@example.invalid' },
          { id: '21111111-2222-4333-8444-555555555555', level: 0, email: 'second@example.invalid' },
        ],
      },
    },
  ],
  outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
});
it('a deliberate complete native JSON edit replaces an uncommitted invalid named-field draft', async () => {
  const original = collectionConfig(),
    graph = importXrayConfig(JSON.stringify(original));
  const node = graph.nodes.find((n) => n.data.kind === 'vmess-inbound')!;
  const apply = vi.fn((_: string, data) => {
    node.data = { ...node.data, ...data };
  });
  await act(() =>
    root.render(
      <ProtocolEditor node={node} defaults={graph.defaults} onApply={apply} onClose={vi.fn()} />,
    ),
  );
  await enter(host.querySelector<HTMLInputElement>('#protocol-settings-clients-0-level')!, '-1');
  await act(() => button('Native JSON').click());
  const raw = host.querySelector<HTMLTextAreaElement>('textarea[data-diagnostic-field="json"]')!;
  const value = JSON.parse(raw.value);
  value.settings.clients[0].email = 'edited@example.invalid';
  await enter(raw, JSON.stringify(value));
  expect(host.querySelector('textarea[data-diagnostic-field="json"]')).toBe(raw);
  await act(() => button('Listener & accounts').click());
  expect(host.querySelector<HTMLInputElement>('#protocol-settings-clients-0-level')!.value).toBe(
    '0',
  );
  expect(button('Apply protocol settings').disabled).toBe(false);
  await act(() => button('Apply protocol settings').click());
  expect((compileXrayGraph(graph).config.inbounds as any[])[0].settings.clients[0]).toEqual({
    ...original.inbounds[0].settings.clients[0],
    email: 'edited@example.invalid',
  });
});

it('edits TCP buffer sizes as Windows socket options and preserves the rest of an imported inbound', async () => {
  const nativeOption = {
    system: 'linux',
    network: 'udp',
    level: '1',
    opt: '8',
    value: '131072',
    type: 'int',
  };
  const original = {
    inbounds: [
      {
        tag: 'proxy',
        listen: '127.0.0.1',
        port: 2080,
        protocol: 'trojan',
        settings: { clients: [] },
        streamSettings: { sockopt: { tcpKeepAliveIdle: 30, customSockopt: [nativeOption] } },
      },
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
  };
  const graph = importXrayConfig(JSON.stringify(original));
  const node = graph.nodes.find((n) => n.data.kind === 'trojan-inbound')!;
  const apply = vi.fn((_: string, data) => {
    node.data = { ...node.data, ...data };
  });
  await act(() =>
    root.render(
      <ProtocolEditor node={node} defaults={graph.defaults} onApply={apply} onClose={vi.fn()} />,
    ),
  );
  await act(() => button('Name detection').click());
  const input = host.querySelector<HTMLInputElement>('#protocol-buffer-tcp-receive')!;
  expect(input.placeholder).toBe('Windows default');
  expect(host.querySelector('#protocol-buffer-udp-receive')).toBeNull();
  await enter(input, '524288');
  await act(() => button('Apply protocol settings').click());
  expect(apply).toHaveBeenCalledOnce();
  expect((compileXrayGraph(graph).config.inbounds as any[])[0]).toEqual({
    ...original.inbounds[0],
    streamSettings: {
      sockopt: {
        tcpKeepAliveIdle: 30,
        customSockopt: [
          nativeOption,
          {
            system: 'windows',
            network: 'tcp',
            level: '65535',
            opt: '4098',
            value: '524288',
            type: 'int',
          },
        ],
      },
    },
  });
});

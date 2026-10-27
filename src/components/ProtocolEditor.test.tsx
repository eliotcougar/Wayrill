// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeNode } from '../graph/catalog';
import { importXrayConfig } from '../graph/xrayImport';
import { compileXrayGraph } from '../graph/xrayCompiler';
import ProtocolEditor from './ProtocolEditor';
import { factoryDefaults, resolveNodeData } from '../graph/defaults';
import { protocolConfig } from '../graph/protocols';
import { coreProjection } from '../graph/xrayProjection';

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
it('applies an explicit zero edit while retaining unrelated native omissions', async () => {
  const { graph, node } = await setup(),
    input = host.querySelector<HTMLInputElement>('#protocol-default-tcpKeepAliveIdle')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('0');
  expect(host.textContent).toContain('Effective · 0 → 45 seconds for outbound TCP');
  expect(
    button('Apply protocol settings').disabled,
    host.querySelector('.rule-editor-diagnostics')?.textContent +
      '\n' +
      [...host.querySelectorAll('[aria-invalid="true"]')]
        .map((el) => el.id + ' ' + el.outerHTML)
        .join('\n'),
  ).toBe(false);
  await act(() => button('Apply protocol settings').click());
  expect(node.data.native?.editedKeys).toContain('tcpKeepAliveIdle');
  const raw = (compileXrayGraph(graph).config.outbounds as any[])[0];
  expect(raw.streamSettings.sockopt.tcpKeepAliveIdle).toBe(0);
  expect(raw.streamSettings.sockopt).not.toHaveProperty('tcpKeepAliveInterval');
  expect(raw.streamSettings.tlsSettings).not.toHaveProperty('fingerprint');
});
it('discards defaults edits on Cancel', async () => {
  const { original, graph, apply, close } = await setup();
  await act(() =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Use default for Client fingerprint"]')!
      .click(),
  );
  expect(host.querySelector<HTMLSelectElement>('#protocol-default-fingerprint')!.value).toBe(
    '__wayrill_inherit__',
  );
  await act(() => button('Cancel').click());
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(compileXrayGraph(graph).config).toEqual(original);
});
it('changes only the requested shared field when Use default is applied', async () => {
  const { graph } = await setup();
  await act(() =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Use default for Client fingerprint"]')!
      .click(),
  );
  await act(() => button('Apply protocol settings').click());
  const raw = (compileXrayGraph(graph).config.outbounds as any[])[0];
  expect(raw.streamSettings.tlsSettings.fingerprint).toBe('chrome');
  expect(raw.streamSettings.tlsSettings.serverName).toBe('public.example');
  expect(raw.streamSettings.sockopt ?? {}).not.toHaveProperty('tcpKeepAliveIdle');
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
it.each(['tun-inbound', 'ics-tun'] as const)(
  'exposes FakeDNS recovery on %s and preserves unrelated sniffing settings',
  async (kind) => {
    const raw = JSON.parse(String(makeNode(kind, { x: 0, y: 0 }).data.settings.json));
    raw.sniffing = {
      enabled: false,
      destOverride: ['http', 'tls'],
      routeOnly: true,
      metadataOnly: true,
    };
    const node = importXrayConfig(
      JSON.stringify({ inbounds: [{ ...raw, tag: 'tun' }] }),
    ).nodes.find((n) => n.data.kind === 'tun-inbound')!;
    node.data.kind = kind;
    const apply = vi.fn((_: string, data) => {
      node.data = { ...node.data, ...data };
    });
    await act(() =>
      root.render(
        <ProtocolEditor
          node={node}
          defaults={factoryDefaults()}
          onApply={apply}
          onClose={vi.fn()}
        />,
      ),
    );
    const checkbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.closest('label')?.textContent?.includes('Recover FakeDNS names'),
    )!;
    expect(checkbox).toBeDefined();
    expect(checkbox.checked).toBe(false);
    await act(() => checkbox.click());
    expect(button('Apply protocol settings').disabled, host.textContent ?? '').toBe(false);
    await act(() => button('Apply protocol settings').click());
    expect(apply).toHaveBeenCalled();
    expect(protocolConfig(node.data).sniffing).toEqual({
      enabled: true,
      destOverride: expect.arrayContaining(['http', 'tls', 'fakedns']),
      routeOnly: true,
      metadataOnly: true,
    });
    await act(() => checkbox.click());
    await act(() => button('Apply protocol settings').click());
    expect(protocolConfig(node.data).sniffing).toEqual({
      enabled: true,
      destOverride: ['http', 'tls'],
      routeOnly: true,
      metadataOnly: true,
    });
  },
);
it('lets a later native JSON omission replace an explicit named zero', async () => {
  const { graph } = await setup();
  await enter(host.querySelector<HTMLInputElement>('#protocol-default-tcpKeepAliveIdle')!, '0');
  await act(() => button('Native JSON').click());
  const raw = host.querySelector<HTMLTextAreaElement>('textarea[data-diagnostic-field="json"]')!,
    value = JSON.parse(raw.value);
  delete value.streamSettings.sockopt.tcpKeepAliveIdle;
  await enter(raw, JSON.stringify(value));
  await act(() => button('Global defaults').click());
  expect(host.querySelector<HTMLInputElement>('#protocol-default-tcpKeepAliveIdle')!.value).toBe(
    '',
  );
  await act(() => button('Apply protocol settings').click());
  const output = (compileXrayGraph(graph).config.outbounds as any[])[0];
  expect(output.streamSettings.sockopt ?? {}).not.toHaveProperty('tcpKeepAliveIdle');
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

it('updates the generic protocol form when its native JSON protocol changes', async () => {
  const node = makeNode('xray-outbound', { x: 0, y: 0 });
  node.data.settings.json = JSON.stringify({
    protocol: 'socks',
    settings: { servers: [{ address: 'public.example', port: 1080 }] },
  });
  const apply = vi.fn(),
    close = vi.fn();
  await act(() => root.render(<ProtocolEditor node={node} onApply={apply} onClose={close} />));
  expect(host.querySelector('h2')!.textContent).toContain('SOCKS');
  await act(() => button('Native JSON').click());
  const value = {
    protocol: 'trojan',
    settings: { servers: [{ address: 'public.example', port: 443, password: 'public-fixture' }] },
  };
  await enter(
    host.querySelector<HTMLTextAreaElement>('textarea[data-diagnostic-field="json"]')!,
    JSON.stringify(value),
  );
  await act(() => button('Server & account').click());
  expect(host.querySelector('h2')!.textContent).toContain('Trojan');
  expect(host.querySelector<HTMLInputElement>('[type="password"]')!.value).toBe('public-fixture');
  await act(() => button('Apply protocol settings').click());
  expect(JSON.parse(apply.mock.calls[0][1].settings.json)).toEqual(value);
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
it('can explicitly remove an invalid account without carrying its unsaved field into the next account', async () => {
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
  await act(() =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove Clients entry"]')!.click(),
  );
  expect(host.querySelector<HTMLInputElement>('#protocol-settings-clients-0-level')!.value).toBe(
    '0',
  );
  expect(host.querySelector<HTMLInputElement>('#protocol-settings-clients-0-email')!.value).toBe(
    'second@example.invalid',
  );
  expect(button('Apply protocol settings').disabled).toBe(false);
  await act(() => button('Apply protocol settings').click());
  expect((compileXrayGraph(graph).config.inbounds as any[])[0].settings.clients).toEqual([
    original.inbounds[0].settings.clients[1],
  ]);
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

it('keeps Windows TUN setup focused on capture and makes IPv4-only scope explicit', async () => {
  const node = makeNode('tun-inbound', { x: 0, y: 0 });
  await act(() => root.render(<ProtocolEditor node={node} onApply={vi.fn()} onClose={vi.fn()} />));
  expect(button('Transport & security')).toBeUndefined();
  expect(host.textContent).not.toContain('Use gateway for system DNS');
  const gateway = () =>
    host.querySelector<HTMLTextAreaElement>('#protocol-settings-gateway')!.value;
  expect(gateway()).toContain('fd90::1/64');
  await act(() => button('Capture IPv4 only').click());
  expect(gateway()).not.toContain('fd90::1/64');
  expect(host.textContent).toContain('IPv6 is outside this capture scope.');
  await act(() => button('Capture this PC · IPv4 + IPv6').click());
  expect(gateway()).toContain('fd90::1/64');
  expect(host.textContent).not.toContain('IPv6 is outside this capture scope.');
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

it('shows both buffer directions for native UDP listeners and prevents applying invalid sizes', async () => {
  const original = {
    inbounds: [
      {
        tag: 'udp',
        protocol: 'tunnel',
        listen: '127.0.0.1',
        port: 2080,
        settings: { allowedNetwork: 'udp', rewriteAddress: '127.0.0.1', rewritePort: 53 },
      },
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
  };
  const graph = importXrayConfig(JSON.stringify(original));
  const node = graph.nodes.find((n) => n.data.kind === 'tunnel-inbound')!;
  const apply = vi.fn((_: string, data) => {
    node.data = { ...node.data, ...data };
  });
  await act(() =>
    root.render(
      <ProtocolEditor node={node} defaults={graph.defaults} onApply={apply} onClose={vi.fn()} />,
    ),
  );
  await act(() => button('Name detection').click());
  expect(host.querySelector('#protocol-buffer-tcp-receive')).toBeNull();
  const input = host.querySelector<HTMLInputElement>('#protocol-buffer-udp-send')!;
  expect(input.placeholder).toBe('Windows default');
  await enter(input, '0');
  expect(button('Apply protocol settings').disabled).toBe(true);
  await enter(input, '131072');
  expect(button('Apply protocol settings').disabled).toBe(false);
  await act(() => button('Apply protocol settings').click());
  expect(
    (compileXrayGraph(graph).config.inbounds as any[])[0].streamSettings.sockopt.customSockopt,
  ).toEqual([
    {
      system: 'windows',
      network: 'udp',
      level: '65535',
      opt: '4097',
      value: '131072',
      type: 'int',
    },
  ]);
});

it('retains inherited UDP defaults when the first buffer override is a TCP edit', async () => {
  const defaults = factoryDefaults();
  const node = makeNode('tunnel-inbound', { x: 0, y: 0 });
  const apply = vi.fn((_: string, data) => {
    node.data = { ...node.data, ...data };
  });
  await act(() =>
    root.render(
      <ProtocolEditor node={node} defaults={defaults} onApply={apply} onClose={vi.fn()} />,
    ),
  );
  await act(() => button('Name detection').click());
  await enter(host.querySelector<HTMLInputElement>('#protocol-buffer-tcp-send')!, '131072');
  await act(() => button('Apply protocol settings').click());
  expect(apply).toHaveBeenCalledOnce();
  const raw = protocolConfig(resolveNodeData(node.data, defaults)) as any;
  expect(raw.streamSettings.sockopt.customSockopt).toEqual([
    {
      system: 'windows',
      network: 'tcp',
      level: '65535',
      opt: '4097',
      value: '131072',
      type: 'int',
    },
  ]);
  expect(coreProjection(defaults).env).toMatchObject({
    WAYRILL_UDP_LISTENER_RECEIVE_BYTES: '262144',
    WAYRILL_UDP_LISTENER_SEND_BYTES: '262144',
  });
});

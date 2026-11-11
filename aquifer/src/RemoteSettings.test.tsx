// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RemoteSettings from './RemoteSettings';
import {
  inboundIssues,
  inboundSchemas,
  fieldsForServer,
  serverStructures,
  get,
  objectAt,
  type ServerObject,
} from './inboundFields';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { replaceNodeSettings } from './nodeSettings';
import sourceSchema from './graph/xrayConfigNames.json';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const certs = {
  certificates: [{ certificateFile: '/etc/ssl/fullchain.pem', keyFile: '/etc/ssl/privkey.pem' }],
};
const id = '00000000-0000-4000-8000-000000000001';
const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const examples: [string, ServerObject, ServerObject?][] = [
  [
    'vless',
    {
      clients: [{ id, reverse: { tag: 'reverse-client' } }],
      decryption: 'none',
      flow: 'xtls-rprx-vision',
    },
    {
      network: 'raw',
      security: 'reality',
      realitySettings: {
        target: 'example.org:443',
        serverNames: ['example.org'],
        privateKey: key.slice(0, -1),
        shortIds: ['', '0123'],
        show: false,
        fingerprint: 'chrome',
      },
    },
  ],
  ['vmess', { clients: [{ id }], default: { level: 1 } }],
  [
    'trojan',
    { clients: [{ password: 'test' }], fallbacks: [{ dest: 8080, xver: 1 }] },
    { security: 'tls', tlsSettings: certs },
  ],
  ['shadowsocks', { method: 'chacha20-poly1305', password: 'test', network: 'tcp,udp' }],
  [
    'shadowsocks',
    {
      method: '2022-blake3-aes-256-gcm',
      password: key,
      clients: [{ password: key, email: 'ss-user' }],
    },
  ],
  [
    'socks',
    { auth: 'password', accounts: [{ user: 'test', pass: 'test' }], udp: true, ip: '192.0.2.2' },
  ],
  ['http', { accounts: [{ user: 'test', pass: 'test' }], allowTransparent: true }],
  ['mixed', { auth: 'password', accounts: [{ user: 'test', pass: 'test' }], udp: true }],
  ['tunnel', { rewriteAddress: '127.0.0.1', rewritePort: 8080, allowedNetwork: 'tcp' }],
  ['dokodemo-door', { address: '127.0.0.1', port: 8080, network: 'tcp,udp', followRedirect: true }],
  [
    'wireguard',
    {
      secretKey: key,
      address: ['10.40.0.1/24'],
      peers: [{ publicKey: key, allowedIPs: ['10.40.0.2/32'] }],
      reserved: [1, 2, 3],
    },
  ],
  [
    'hysteria',
    { version: 2, clients: [{ auth: 'test' }] },
    { network: 'hysteria', security: 'tls', tlsSettings: certs, hysteriaSettings: { version: 2 } },
  ],
  [
    'masque',
    { address: ['10.40.0.1/24', 'fd40::1/64'], clients: [{ email: 'alice', pass: 'test' }] },
    { network: 'masque', security: 'tls', tlsSettings: certs },
  ],
  [
    'tun',
    {
      name: 'xray-tun',
      gateway: ['10.40.0.1/30'],
      autoSystemRoutingTable: ['0.0.0.0/0'],
      autoOutboundsInterface: 'eth0',
      desc: 'Windows-only preserved value',
    },
  ],
];
const inbound = (
  protocol: string,
  settings: ServerObject,
  streamSettings?: ServerObject,
): ServerObject => ({
  tag: 'server',
  protocol,
  ...(protocol === 'tun' ? {} : { listen: '0.0.0.0', port: 443 }),
  settings,
  ...(streamSettings ? { streamSettings } : {}),
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find(
    (button) =>
      (button.getAttribute('role') === 'tab'
        ? button.childNodes[0]?.textContent?.trim()
        : button.textContent?.trim()) === text,
  )!;
const control = (name: string) =>
  host.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[aria-label="${name}"]`,
  )!;
async function setControl(name: string, value: string) {
  const input = control(name);
  const prototype =
    input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
async function render(value: ServerObject, onSave = vi.fn(), onManageUsers?: () => void) {
  await act(async () =>
    root.render(
      <RemoteSettings
        title="Server"
        schema="InboundDetourConfig"
        destinations={[]}
        value={value}
        onSave={onSave}
        onClose={vi.fn()}
        onManageUsers={onManageUsers}
      />,
    ),
  );
  return onSave;
}

it.each(examples)(
  'edits and graph-exports %s without rewriting unrelated server options',
  async (protocol, settings, stream) => {
    const value = inbound(protocol, settings, stream),
      save = await render(value);
    expect(inboundIssues(value)).toEqual([]);
    await setControl('Tag', 'renamed-listener');
    await act(async () => button('Apply changes').click());
    expect(save).toHaveBeenCalledWith({ ...value, tag: 'renamed-listener' });
    const config = { inbounds: [value], outbounds: [{ tag: 'direct', protocol: 'freedom' }] };
    const view = remoteView(JSON.stringify(config));
    const edited = replaceNodeSettings(view, 'native-in-0', save.mock.calls[0][0]);
    const output = compileRemote(edited, createUserWorkspace(config, emptyLibrary()));
    expect(output.errors).toEqual([]);
    expect(output.config).toEqual({ ...config, inbounds: [{ ...value, tag: 'renamed-listener' }] });
    const core = process.env.WAYRILL_REMOTE_EDITOR_CORE;
    if (core) {
      // -test builds the config only: no listener, adapter, or remote server is started.
      const testConfig = structuredClone(output.config);
      for (const item of testConfig.inbounds as ServerObject[]) {
        const tls = objectAt(objectAt(item, 'streamSettings'), 'tlsSettings');
        if (Array.isArray(tls.certificates))
          for (const certificate of tls.certificates) {
            certificate.certificateFile = process.env.WAYRILL_REMOTE_TEST_CERTIFICATE;
            certificate.keyFile = process.env.WAYRILL_REMOTE_TEST_KEY;
          }
      }
      const directory = resolve('.tools/inbound-core-fixtures');
      mkdirSync(directory, { recursive: true });
      const name =
        protocol + (get(settings, 'method')?.toString().startsWith('2022-') ? '-2022' : '');
      const file = join(directory, name + '.json');
      writeFileSync(file, JSON.stringify(testConfig));
      const result = spawnSync(core, ['run', '-test', '-config', file], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      writeFileSync(join(directory, name + '.log'), result.stdout + result.stderr);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
  },
);

it('covers every inbound from the Xray protocol registry', () => {
  expect(new Set(Object.keys(inboundSchemas))).toEqual(
    new Set(Object.keys(sourceSchema.protocols.inbound)),
  );
  expect(new Set(examples.map(([protocol]) => protocol))).toEqual(
    new Set(Object.keys(sourceSchema.protocols.inbound)),
  );
});
it('keeps the structured field registry aligned with the imported Xray source schema', () => {
  const structures: Record<string, Record<string, string>> = sourceSchema.structures;
  for (const [schema, fields] of Object.entries(serverStructures)) {
    if (!structures[schema]) continue;
    for (const field of fields)
      expect(Object.hasOwn(structures[schema], field.key), `${schema}.${field.key}`).toBe(true);
  }
});
it('uses a Unix socket listener without requiring a port and preserves an existing ignored port', async () => {
  const value = {
    ...inbound('vless', { decryption: 'none' }),
    listen: '/run/xray/server.sock',
    port: '10000-10010',
  };
  const save = await render(value);
  expect(control('Listen port')).toBeNull();
  await act(async () => button('Apply changes').click());
  expect(save).toHaveBeenCalledWith(value);
});
it('hides client security, dormant transports, and Windows-only TUN options', async () => {
  await render(
    inbound(
      'vless',
      { decryption: 'none' },
      {
        security: 'reality',
        realitySettings: { target: 'example.org:443' },
        wsSettings: { path: '/dormant' },
      },
    ),
  );
  await act(async () => button('Transport & security').click());
  expect(control('Camouflage target')).not.toBeNull();
  for (const name of ['Fingerprint', 'Public key', 'Server name', 'Path'])
    expect(control(name)).toBeNull();
  expect(fieldsForServer('TLSConfig', {}, {}).map((field) => field.key)).not.toContain(
    'allowInsecure',
  );
  expect(fieldsForServer('TunConfig', {}, {}).map((field) => field.key)).not.toContain(
    'autoSystemWfpBlockLeak',
  );
  expect(fieldsForServer('GRPCConfig', {}, {}).map((field) => field.key)).not.toContain(
    'multiMode',
  );
  expect(fieldsForServer('WireGuardConfig', {}, {}).map((field) => field.key)).not.toContain(
    'noKernelTun',
  );
  expect(
    fieldsForServer('SocketConfig', {}, inbound('wireguard', {})).map((field) => field.key),
  ).not.toContain('tcpFastOpen');
});
it('keeps optional values absent, but can add and reset advanced settings', async () => {
  const value = inbound('mixed', { auth: 'noauth' }),
    save = await render(value);
  await setControl('Allow UDP', 'true');
  await setControl('User policy level', '4');
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Use default for User policy level"]')!
      .click(),
  );
  await act(async () => button('Apply changes').click());
  expect(save).toHaveBeenCalledWith({ ...value, settings: { auth: 'noauth', udp: true } });
});
it('reports missing required fields and allows changing sections to fix them', async () => {
  const save = await render(inbound('vless', {}, { security: 'reality' }));
  await act(async () => button('Apply changes').click());
  expect(save).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Decryption is required');
  await setControl('Decryption', 'none');
  await act(async () => button('Apply changes').click());
  expect(button('Transport & security').getAttribute('aria-selected')).toBe('true');
  expect(control('Camouflage target').getAttribute('aria-invalid')).toBe('true');
  await act(async () => button('Listener').click());
  expect(control('Decryption')).not.toBeNull();
});
it('preserves empty REALITY short IDs and numeric fallback destinations during edits', async () => {
  const value = inbound(...examples[0]),
    save = await render(value);
  await act(async () => button('Transport & security').click());
  expect(control('Short ID 1').value).toBe('');
  await setControl('Short ID 2', 'aabb');
  await act(async () => button('Apply changes').click());
  expect((save.mock.calls[0][0] as any).streamSettings.realitySettings.shortIds).toEqual([
    '',
    'aabb',
  ]);
  expect(inboundIssues(inbound('trojan', { fallbacks: [{ dest: 8080, xver: 1 }] }))).toEqual([]);
});
it('rejects numeric overflow, broken short IDs and unsupported REALITY transports', () => {
  const value = inbound(
    'vless',
    { decryption: 'none' },
    {
      network: 'ws',
      security: 'reality',
      realitySettings: {
        target: 'example.org:443',
        serverNames: ['example.org'],
        privateKey: key,
        shortIds: ['a'],
      },
    },
  );
  value.port = '65536';
  const issues = inboundIssues(value);
  expect(issues.map((issue) => issue.path)).toEqual(
    expect.arrayContaining([
      'port',
      'streamSettings.security',
      'streamSettings.realitySettings.shortIds.0',
    ]),
  );
});
it.each([
  ['array', ['ssl', 'quic']],
  ['comma-separated string', 'SSL,quic'],
] as const)(
  'edits sniffing protocol aliases in a %s while preserving other fields',
  async (_form, protocols) => {
    const value = {
        ...inbound('http', {}),
        sniffing: { enabled: true, destOverride: protocols, futureField: 12 },
      },
      save = await render(value);
    await act(async () => button('Sniffing').click());
    const tls = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.parentElement?.textContent === 'TLS',
    )!;
    expect(tls.checked).toBe(true);
    await act(async () => tls.click());
    await act(async () => button('Apply changes').click());
    expect(save.mock.calls[0][0].sniffing).toEqual({
      enabled: true,
      destOverride: ['quic'],
      futureField: 12,
    });
  },
);
it('allows users to be managed while the inbound draft is incomplete', async () => {
  const manage = vi.fn();
  const save = await render(inbound('vless', {}), vi.fn(), manage);
  await setControl('Tag', 'users-here');
  await act(async () => button('Manage users').click());
  expect(manage).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect(control('Tag').value).toBe('users-here');
});
it('opens Advanced when a fallback needs correction, and keeps it open during editing', async () => {
  const value = inbound('trojan', { fallbacks: [{}] }),
    save = await render(value);
  const disclosure = host.querySelector<HTMLDetailsElement>('.server-advanced')!;
  expect(disclosure.open).toBe(false);
  await act(async () => button('Apply changes').click());
  expect(save).not.toHaveBeenCalled();
  expect(disclosure.open).toBe(true);
  await setControl('Destination', '8080');
  expect(disclosure.open).toBe(true);
  await act(async () => button('Apply changes').click());
  expect(save.mock.calls[0][0].settings.fallbacks).toEqual([{ dest: 8080 }]);
});
it('edits numeric arrays as numbers and allows a trailing newline while typing lists', async () => {
  const save = await render(inbound('vless', { decryption: 'none', testseed: [1, 2, 3, 4] }));
  await setControl('Test seed', '5\n6\n7\n8\n');
  expect(control('Test seed').value).toBe('5\n6\n7\n8\n');
  await act(async () => button('Apply changes').click());
  expect(save.mock.calls[0][0].settings.testseed).toEqual([5, 6, 7, 8]);
});
it('migrates REALITY to WebSocket with TLS and keeps the old key material dormant', async () => {
  const value = inbound(...examples[0]),
    save = await render(value);
  await act(async () => button('Transport & security').click());
  await setControl('Transport', 'ws');
  expect(control('Security').value).toBe('tls');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('TLS selected');
  await setControl('Certificate file', '/etc/ssl/site.pem');
  await setControl('Private key file', '/etc/ssl/site.key');
  await setControl('Path', '/connect');
  await act(async () => button('Apply changes').click());
  const stream = save.mock.calls[0][0].streamSettings;
  expect(stream.network).toBe('ws');
  expect(stream.wsSettings.path).toBe('/connect');
  expect(stream.realitySettings).toEqual((value.streamSettings as any).realitySettings);
});
it('can put TLS behind a reverse proxy without deleting certificate settings', async () => {
  const value = inbound('trojan', {}, { network: 'ws', security: 'tls', tlsSettings: certs }),
    save = await render(value);
  await act(async () => button('Transport & security').click());
  await setControl('Security', 'none');
  expect(control('Certificate file')).toBeNull();
  await act(async () => button('Apply changes').click());
  expect(save.mock.calls[0][0].streamSettings.tlsSettings).toEqual(certs);
});
it('preserves the rest of the error list as individual fields are corrected', async () => {
  await render(inbound('vless', {}, { security: 'reality' }));
  await act(async () => button('Apply changes').click());
  await setControl('Decryption', 'none');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Camouflage target is required',
  );
  expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('Decryption is required');
});
it('uses manual activation for arrow, Home and End navigation across editor tabs', async () => {
  await render(inbound('vless', { decryption: 'none' }));
  const first = button('Listener');
  await act(async () => {
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  expect(document.activeElement).toBe(button('Transport & security'));
  expect(first.getAttribute('aria-selected')).toBe('true');
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ),
  );
  expect(button('Transport & security').getAttribute('aria-selected')).toBe('true');
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(button('Advanced'));
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(first);
});
it('protects unsaved edits on Cancel, without treating JSON formatting as a change', async () => {
  const close = vi.fn(),
    confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const value = inbound('vless', { decryption: 'none' });
  await act(async () =>
    root.render(
      <RemoteSettings
        title="Server"
        schema="InboundDetourConfig"
        destinations={[]}
        value={value}
        onSave={vi.fn()}
        onClose={close}
      />,
    ),
  );
  await setControl('Tag', 'new-tag');
  await act(async () => button('Cancel').click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect(control('Tag').value).toBe('new-tag');
  await setControl('Tag', 'server');
  await act(async () => button('Edit JSON').click());
  await setControl('Node settings JSON', JSON.stringify(value));
  await act(async () => button('Cancel').click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it('edits a simple DNS server address without requiring raw JSON', async () => {
  const save = vi.fn();
  await act(async () =>
    root.render(
      <RemoteSettings
        title="DNS server"
        schema="NameServerConfig"
        destinations={[]}
        value="localhost"
        onSave={save}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(control('Node settings JSON')).toBeNull();
  await setControl('DNS server address', 'https://dns.example.org/dns-query');
  await act(async () => button('Apply changes').click());
  expect(save).toHaveBeenLastCalledWith({ address: 'https://dns.example.org/dns-query' });
  expect(control('DNS server port')).not.toBeNull();
});

it('keeps every tab linked to an existing panel before and after selection', async () => {
  await render(inbound('vless', { decryption: 'none' }));
  const verify = () => {
    for (const tab of host.querySelectorAll('[role="tab"]')) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!);
      expect(panel, tab.textContent ?? '').not.toBeNull();
      expect(panel?.getAttribute('role')).toBe('tabpanel');
    }
    const active = host.querySelector('[role="tab"][aria-selected="true"]')!;
    const panel = document.getElementById(active.getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('aria-labelledby')).toBe(active.id);
  };
  verify();
  await act(async () => button('Transport & security').click());
  verify();
});

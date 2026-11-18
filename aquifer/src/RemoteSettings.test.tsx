// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import RemoteSettings from './RemoteSettings';
import {
  inboundIssues,
  inboundSchemas,
  serverStructures,
  type ServerObject,
} from './inboundFields';
import sourceSchema from './graph/xrayConfigNames.json';
import { certs, key, examples, inbound } from './test/inboundExamples';
import { host, root, button, control, change as setControl } from './test/settingsHarness';

async function render(value: ServerObject) {
  const onSave = vi.fn();
  await act(async () =>
    root.render(
      <RemoteSettings
        title="Server"
        schema="InboundDetourConfig"
        destinations={[]}
        value={value}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    ),
  );
  return onSave;
}

it('covers every inbound from the Xray protocol registry', () => {
  expect(new Set(Object.keys(inboundSchemas))).toEqual(
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
it('saves an added REALITY short ID alongside empty and manually edited entries', async () => {
  const value = inbound(...examples[0]),
    save = await render(value);
  await act(async () => button('Transport & security').click());
  expect(control('Short ID 1').value).toBe('');
  await setControl('Short ID 2', 'aabb');
  await act(async () => button('Add short ID').click());
  await act(async () => button('Apply changes').click());
  expect((save.mock.calls[0][0] as any).streamSettings.realitySettings.shortIds).toEqual([
    '',
    'aabb',
    expect.stringMatching(/^(?:[a-f0-9]{2}){1,8}$/i),
  ]);
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
